import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { BUILTIN_ATTRIBUTION } from "./builtin-attribution.js";
import { callerPackageOf } from "./ownership-channel.js";
import { scanForOwners } from "./tool-scan.js";

/**
 * Owner attribution.
 *
 * The tool registry keeps no ownership metadata, so this module recovers it from
 * several sources, in order of authority:
 *
 *  L1 — the carrier context. `ctx.on("internal/get")` fires when a plugin's
 *       context first resolves the `tools` service, and the event's first
 *       argument is *that* context. Its `[cordis.entry].options.name` is the
 *       plugin's package name — exact, free, and correct for every registration
 *       made through that resolution. A registration from the root context
 *       (the harness's own tools) answers `undefined`, which is the truth: no
 *       profile plugin owns those.
 *  L2 — the stack, only as a fallback. `register` also reaches us through paths
 *       that never resolved `tools` on a plugin context (a re-entrant call from
 *       framework code). There the call stack still contains the registrant's
 *       module path, so walking up to the nearest `package.json` yields the
 *       package name. Cached per directory, and only consulted when L1 declined.
 *
 * L3 — an on-disk scan of the profile's installed bundles (`tool-scan.js`), plus a
 *       small checked-in snapshot as a last resort. Both are consulted only for
 *       names neither L1 nor L2 could place, so a static tool that registered
 *       before this plugin mounted still resolves — including one from a plugin
 *       that was installed after this file was written.
 *
 * Anything still unknown stays unknown, and `unknownOwnerPolicy` decides whether
 * it is exposed (default) or collapsed.
 */

const UNKNOWN = "<unknown>";
const STACK_LINE = /^\s*at\s+/;
const LOCATION = /\(?([^()]+):\d+:\d+\)?$/;
const MAX_PACKAGE_WALK = 12;

/**
 * Packages that are infrastructure, never a plugin.
 *
 * `@deepseek-ai/cordis` is the dependency-injection framework itself. A tool
 * registered from inside one of its effects walks through framework frames, so the
 * nearest `package.json` can be the framework rather than the plugin that asked
 * for the registration. Treating that as an owner invents a family named after the
 * framework and puts `ask_user_question`, `todo_write` and friends in it — tools
 * that sit on the wire unconditionally, so the gateway behind them would be pure
 * overhead.
 *
 * A frame belonging to one of these is skipped and the walk continues outward,
 * which lands on the real plugin.
 */
const FRAMEWORK_PACKAGES = new Set([
  "@deepseek-ai/cordis",
  "@deepseek-ai/cosmokit",
  "@deepseek-ai/schemastery",
]);

/** The registrant's own package root, excluded from stack attribution. */
const SELF_PACKAGE_DIR = (() => {
  try {
    return path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  } catch {
    return undefined;
  }
})();

const SELF_PACKAGE_NAME = (() => {
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(SELF_PACKAGE_DIR, "package.json"), "utf8"),
    );
    return typeof manifest.name === "string" ? manifest.name : undefined;
  } catch {
    return undefined;
  }
})();

/** Normalize a stack frame's file path, or return undefined when it is not a file URL/path. */
function frameFile(frame) {
  let text = frame.trim().slice(3);
  if (text.startsWith("async ")) text = text.slice(6);
  text = text.replace(/\)\s*$/, "");
  const match = LOCATION.exec(text);
  if (match === null) return undefined;
  let file = match[1];
  if (file.includes("(")) file = file.slice(file.lastIndexOf("(") + 1);
  if (file.startsWith("file://")) {
    try {
      file = fileURLToPath(file);
    } catch {
      return undefined;
    }
  } else if (
    !/^[A-Za-z]:[\\/]/.test(file) &&
    !file.startsWith("/") &&
    !file.startsWith("\\\\") &&
    !file.startsWith("node:")
  ) {
    return undefined;
  }
  try {
    return path.resolve(file);
  } catch {
    return undefined;
  }
}

/** Read the `name` of the nearest `package.json` above `file`, with a directory cache. */
function packageNameOf(file, cache) {
  let dir = path.dirname(file);
  for (let depth = 0; depth < MAX_PACKAGE_WALK; depth += 1) {
    if (cache.has(dir)) {
      const hit = cache.get(dir);
      if (hit !== undefined) return hit;
    }
    const manifestPath = path.join(dir, "package.json");
    if (fs.existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        const name = typeof manifest.name === "string" && manifest.name !== "" ? manifest.name : undefined;
        cache.set(dir, name);
        if (name !== undefined) return name;
      } catch {
        cache.set(dir, undefined);
      }
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return undefined;
}

/** Attribute the current call stack to a package name, skipping our own frames. */
function ownerFromStack(cache) {
  const stack = String(new Error().stack ?? "");
  for (const line of stack.split("\n")) {
    if (!STACK_LINE.test(line)) continue;
    const file = frameFile(line);
    if (file === undefined) continue;
    if (SELF_PACKAGE_DIR !== undefined && file.startsWith(SELF_PACKAGE_DIR)) continue;
    if (file.startsWith("node:")) continue;
    const name = packageNameOf(file, cache);
    if (name !== undefined) {
      if (name === SELF_PACKAGE_NAME) continue;
      // Infrastructure frames sit between the plugin and the registry: keep
      // walking instead of blaming the framework for a plugin's tool.
      if (FRAMEWORK_PACKAGES.has(name)) continue;
      return name;
    }
  }
  return undefined;
}

/**
 * Build the ownership index for this plugin instance.
 *
 * @param ctx - this plugin's context (global layer).
 * @param logger - plugin logger for one-line diagnostics.
 * @param options.unscannable - names no installed bundle can claim (this plugin's
 *   own gateway tools). Skipping them is what keeps the on-disk scan off the hot
 *   path; see `registered()`.
 * @param options.diskScan - whether the on-disk scan may run at all. Off means
 *   only live and static attribution are used: a tool registered before this
 *   plugin mounted and absent from the static table stays unattributed, which
 *   `unknownOwnerPolicy` then governs. Either a boolean or a `() => boolean`
 *   reader — the config field is volatile, so the user can flip it mid-session.
 * @returns `{ ownerOf, snapshot, registered, dispose }`.
 */
export function createOwnerIndex(ctx, logger, options = {}) {
  const { unscannable = new Set() } = options;
  const diskScanReader = options.diskScan ?? true;
  const diskScan = () =>
    typeof diskScanReader === "function" ? diskScanReader() !== false : diskScanReader !== false;
  /** name -> package name, recorded live by the wrapper below. */
  const live = new Map();
  /** name -> package name, discovered by reading the installed bundles (see tool-scan.js). */
  const scanned = new Map();
  /** directory -> package name | undefined */
  const packageCache = new Map();
  /** Tools present in the global layer before we wrapped anything: unknown-plugin candidates. */
  const preexisting = new Set();
  const wrapped = new WeakSet();
  const restorers = [];
  /**
   * Bumped whenever the set of placeable names could have changed: a live
   * registration, a live disposal, or a scan that learned something. `registered`
   * memoizes on this instead of recomputing per call.
   */
  let revision = 0;
  /** `{ key, value }` — the last `registered()` answer. */
  let cached;

  const record = (target) => {
    if (target === null || typeof target !== "object") return;
    if (wrapped.has(target)) return;
    const original = target.register;
    if (typeof original !== "function") return;
    // Idempotence guard against a second wrapper from another plugin instance.
    const base = original.attributedOriginal ?? original;
    if (typeof base !== "function") return;
    wrapped.add(target);
    const wrapper = function register(definition) {
      const name = definition?.name;
      // L1: the carrier. `this` is the traceable proxy Cordis builds for the
      // service, so `this.ctx` is the context the *call* came from. Read it
      // before delegating: the stack fallback must not see our own frame first.
      let owner = callerPackageOf(this);
      if (owner === undefined) {
        // L2: a call that arrived without a plugin context (framework re-entry).
        try {
          owner = ownerFromStack(packageCache);
        } catch {
          owner = undefined;
        }
      }
      const disposer = base.call(this, definition);
      if (typeof name === "string" && name !== "" && owner !== undefined) {
        live.set(name, owner);
        revision += 1;
        if (typeof disposer === "function") {
          return () => {
            try {
              return disposer();
            } finally {
              if (live.delete(name)) revision += 1;
            }
          };
        }
      }
      return disposer;
    };
    wrapper.attributedOriginal = base;
    try {
      target.register = wrapper;
      restorers.push(() => {
        // Compare against the *original object*, not the proxy we were handed.
        // `target` may be a traceable proxy that returns a fresh proxy per
        // property access, so `target.register === wrapper` is always false and
        // the restore would silently never run — leaving a dead wrapper behind
        // for the next plugin instance to stack on top of.
        if (base !== undefined && typeof base === "function") {
          try {
            target.register = base;
          } catch {
            /* the instance is gone; nothing to restore */
          }
        }
      });
    } catch {
      wrapped.delete(target);
    }
  };

  /**
   * Remember every name the registry already holds, so a name we never saw
   * registered can still be classified as "a real tool, owner unknown".
   *
   * Both the global layer **and every scoped layer** must be read. Reading only
   * the global one misses a whole class of real tools: a bundle that registers
   * inside `ctx.inject(["<service>"], …)` puts its tools in a scoped layer, and
   * `dsh-tool-schedule` does exactly that (`dsh-tool-schedule/lib/index.js:498`).
   * Because this plugin mounts last, those registrations always happen before us,
   * so without the scoped scan they look like tools that do not exist.
   *
   * The distinction matters downstream: a name collected here is offered to the
   * static attribution table, whereas a name absent everywhere stays undefined and
   * is governed by `unknownOwnerPolicy` instead.
   */
  const learnPreexisting = (tools) => {
    const absorb = (layer) => {
      if (layer === undefined || typeof layer.entries !== "function") return;
      for (const [name] of layer.entries()) {
        if (!preexisting.has(name)) {
          preexisting.add(name);
          revision += 1;
        }
      }
    };
    try {
      const layers = tools?.layers;
      absorb(layers?.global?.tools);
      // `layers.scoped` is a Map of scope key -> layer, created lazily. A layout
      // change here only costs us the "known tool, unknown owner" hint, so a
      // failed read is survivable and must never break registration.
      const scoped = layers?.scoped;
      if (scoped !== undefined && typeof scoped.values === "function") {
        for (const layer of scoped.values()) absorb(layer?.tools);
      }
    } catch {
      /* a future layout change only costs us the "known plugin, unknown package" hint */
    }
  };

  // Every context that resolves the registry for the first time passes here.
  // `carrier` is the context doing the resolving, and Cordis hands the same one
  // to the wrapped `register` as `this.ctx` — so attribution happens there, not
  // here. All this listener has to do is make sure every registry instance a
  // plugin can reach is wrapped at all.
  const offGet = ctx.on("internal/get", (carrier, property, _error, next) => {
    if (property !== "tools") return next();
    const tools = next();
    learnPreexisting(tools);
    record(tools);
    return tools;
  });

  try {
    learnPreexisting(ctx.get("tools", false));
    record(ctx.get("tools", false));
  } catch {
    /* resolved lazily on first use instead */
  }

  ctx.effect(
    () => () => {
      offGet?.();
      for (const restore of restorers.splice(0)) restore();
    },
    "dsh-tool-gate: tool attribution",
  );

  const ownerOf = (name) => {
    if (typeof name !== "string" || name === "") return undefined;
    const recorded = live.get(name);
    if (recorded !== undefined) return recorded;
    if (name.startsWith("mcp__")) {
      // mcp__<server>__<tool> / mcp__<server>_<tool>: the server segment is the owner.
      const rest = name.slice("mcp__".length);
      const cut = rest.indexOf("__");
      const server = cut > 0 ? rest.slice(0, cut) : rest.split("_")[0];
      if (server !== undefined && server !== "") return `mcp:${server}`;
    }
    const builtin = BUILTIN_ATTRIBUTION[name];
    if (builtin !== undefined) return builtin;
    const scannedOwner = scanned.get(name);
    if (scannedOwner !== undefined) return scannedOwner;
    if (preexisting.has(name)) return UNKNOWN;
    return undefined;
  };

  return {
    ownerOf,
    /**
     * Ownership of every tool that is *actually registered right now*.
     *
     * Two sources must be combined, and neither alone is enough:
     *
     *  - `live` (tools registered after this plugin mounted, any layer) plus
     *    `preexisting` (the global layer, read at mount time);
     *  - the static table, but **only for names the registry actually knows**.
     *
     * The second half is not a nicety. A tool registered *before* this plugin
     * mounted and *outside the global layer* is invisible to both live sources —
     * `dsh-tool-schedule` does exactly that, registering its four tools inside
     * `ctx.inject(["schedule"], …)`. Without the static table those tools have no
     * owner, so they would never form a family.
     *
     * The filter keeps the other direction safe: the static table names 141 tools
     * whether or not their plugin is installed, so including it unfiltered would
     * conjure gateways for plugins the user does not have.
     *
     * @param known - names the registry can currently serve; static entries
     *   outside this set are ignored. Omit to skip the static layer entirely.
     * @returns `{ [toolName]: packageName | "mcp:<server>" }`.
     */
    registered(known) {
      // The whole point of this function is to answer "which tools exist and who
      // owns them". Both halves change rarely (a plugin mounts, or a tool is
      // registered) and this is called on every assembly and every guarded call,
      // so an unchanged answer is memoized on a revision counter rather than
      // recomputed. `known` is folded in as its own key, since two callers can
      // legitimately ask about different scopes.
      const knownKey = known === undefined ? "-" : [...known].sort().join("\u0000");
      const cacheKey = `${revision}\u0000${knownKey}`;
      if (cached !== undefined && cached.key === cacheKey) return cached.value;

      const candidates = new Set([...live.keys(), ...preexisting]);
      if (known !== undefined) {
        for (const name of Object.keys(BUILTIN_ATTRIBUTION)) {
          if (known.has(name)) candidates.add(name);
        }
        for (const name of known) candidates.add(name);
      }
      // Anything still unplaced is handed to the on-disk scan, which asks the
      // installed bundles directly. This is what makes a brand-new plugin form a
      // family without anyone regenerating a table.
      //
      // `unscannable` keeps that affordable. The scan reads every installed
      // bundle's source, so a name no bundle can ever claim would force a full
      // re-read on *every* call. This plugin's own gateway tools are exactly
      // that — registered by us, absent from every bundle's source — and they
      // were costing 320–480 ms per call against this profile, versus 0.1 ms
      // without them. Their absence also explains the phantom family the
      // settings page used to show for `dsh-tool-gate` itself.
      const unplaced = new Set();
      for (const name of candidates) {
        if (unscannable.has(name)) continue;
        const owner = ownerOf(name);
        if (owner === undefined || owner === UNKNOWN) unplaced.add(name);
      }
      if (unplaced.size > 0 && diskScan()) {
        try {
          let learned = false;
          for (const [name, pkg] of Object.entries(scanForOwners(unplaced, logger))) {
            if (!scanned.has(name)) learned = true;
            scanned.set(name, pkg);
          }
          if (learned) revision += 1;
        } catch (error) {
          logger?.debug?.(`dsh-tool-gate: tool scan failed: ${error?.message ?? error}`);
        }
      }
      const out = {};
      for (const name of candidates) {
        const owner = ownerOf(name);
        if (owner !== undefined && owner !== UNKNOWN) out[name] = owner;
      }
      cached = { key: cacheKey, value: out };
      return out;
    },
    /** Diagnostic dump: name -> owner for every name the index can place. */
    snapshot() {
      const out = {};
      for (const name of new Set([...live.keys(), ...preexisting, ...Object.keys(BUILTIN_ATTRIBUTION)])) {
        const owner = ownerOf(name);
        if (owner !== undefined) out[name] = owner;
      }
      return out;
    },
    dispose() {
      for (const restore of restorers.splice(0)) restore();
      offGet?.();
    },
  };
}

export { UNKNOWN, SELF_PACKAGE_NAME };
