import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { BUILTIN_ATTRIBUTION } from "./builtin-attribution.js";

/**
 * Owner attribution.
 *
 * The tool registry keeps no ownership metadata, so this module recovers it from
 * two sources, in order:
 *
 *  L1 — instance `register` wrapper. `ctx.on("internal/get")` fires whenever a
 *       context first resolves the `tools` service from its ancestor chain;
 *       wrapping that instance's `register` (never the prototype) lets us record
 *       which package registered a name. This is the same technique
 *       `dsh-context` uses; it is defensive here because we delete the entry as
 *       soon as the registrant's disposer runs.
 *  L2 — stack → nearest `package.json`. At registration time the call stack still
 *       contains the registrant's module path; walking up to the nearest
 *       `package.json` yields the package name. Cached per directory.
 *
 * L3 — a generated snapshot of the profile's live registry. Only consulted for
 *       names neither L1 nor L2 could place, so a static tool that registered
 *       before this plugin mounted still resolves.
 *
 * Anything still unknown stays unknown, and `unknownOwnerPolicy` decides whether
 * it is exposed (default) or collapsed.
 */

const UNKNOWN = "<unknown>";
const STACK_LINE = /^\s*at\s+/;
const LOCATION = /\(?([^()]+):\d+:\d+\)?$/;
const MAX_PACKAGE_WALK = 12;

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
 * @returns `{ ownerOf, snapshot, dispose }`.
 */
export function createOwnerIndex(ctx, logger) {
  /** name -> package name, recorded live by the wrapper below. */
  const live = new Map();
  /** directory -> package name | undefined */
  const packageCache = new Map();
  /** Tools present in the global layer before we wrapped anything: unknown-plugin candidates. */
  const preexisting = new Set();
  const wrapped = new WeakSet();
  const restorers = [];

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
      let owner;
      try {
        owner = ownerFromStack(packageCache);
      } catch {
        owner = undefined;
      }
      const disposer = base.call(this, definition);
      if (typeof name === "string" && name !== "" && owner !== undefined) {
        live.set(name, owner);
        if (typeof disposer === "function") {
          return () => {
            try {
              return disposer();
            } finally {
              live.delete(name);
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
        if (target.register === wrapper) target.register = base;
      });
    } catch {
      wrapped.delete(target);
    }
  };

  /** Remember what the global layer already owns, so an unplaceable name can be classified. */
  const learnPreexisting = (tools) => {
    try {
      const layer = tools?.layers?.global?.tools;
      if (layer !== undefined && typeof layer.entries === "function") {
        for (const [name] of layer.entries()) preexisting.add(name);
      }
    } catch {
      /* a future layout change only costs us the "known plugin, unknown package" hint */
    }
  };

  // Every context that resolves the registry for the first time passes here.
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
    if (preexisting.has(name)) return UNKNOWN;
    return undefined;
  };

  return {
    ownerOf,
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

export { UNKNOWN };
