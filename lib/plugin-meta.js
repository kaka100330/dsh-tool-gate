/**
 * Plugin display metadata, read from the host instead of from a table in here.
 *
 * The settings page's plugin list already shows one sentence per plugin, and it
 * is not hard-coded anywhere: `@deepseek-ai/dsh-app-boot` publishes a
 * `pluginPackages` service and `dsh-host-plugin-inventory` renders
 * `metaOf(entry.options.name, entry.parent.tree.ctx.baseUrl)`. This module asks
 * the same service the same way, so the two can never disagree, and a plugin
 * installed tomorrow has a description with no edit here.
 *
 * Three layers, in order:
 *
 *  1. `pluginPackages.metaOf(specifier, baseUrl)` — locale files first, the
 *     package manifest as its own fallback. Exactly what the settings page does.
 *  2. `pluginPackages.packageOf(...).manifest.description` — covers a plugin that
 *     ships no `locale/` and does not export `./package.json`
 *     (`dsh-video-storyboard` is that case: layer 1 returns nothing at all).
 *  3. The caller's own fallback (`lib/family-labels.js`) — for first-party
 *     packages whose manifest describes the module rather than the plugin, and
 *     for the `mcp_servers` pseudo-family, which has no package.
 *
 * Every read is cached by manifest path + mtime, so a plugin upgrade is picked up
 * without a restart and a steady-state turn pays one `stat` per family at most.
 *
 * The service is fetched with `ctx.get`, never declared in `inject`: a hard
 * dependency that is missing would stall this plugin forever, and with the
 * service absent every layer above simply degrades to layer 3.
 */

import fs from "node:fs";

import { barePackageName } from "./ownership-channel.js";

/** Longest description this module will hand on, in code points. */
const DEFAULT_CAP = 120;

/**
 * Summarize a plugin description to one sentence.
 *
 * Plugin descriptions run up to 1.2 KB (`dsh-blender-plugin`), and a gateway's
 * description is prompt text repeated on every turn, so what goes in has to be
 * the first sentence and nothing else.
 *
 * Counting is by code point, not `String.length`: a CJK character or an emoji
 * occupies two UTF-16 units, and `slice(0, cap)` would cut one in half and ship
 * a lone surrogate.
 *
 * @param text - the raw description.
 * @param cap - maximum code points to keep.
 * @returns one sentence, with an ellipsis when it had to be cut.
 */
export function summarize(text, cap = DEFAULT_CAP) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  if (flat === "") return "";
  // The first real sentence end: a CJK full stop/exclamation/question mark, or an
  // ASCII period followed by whitespace or end of string (so `v3.0.4` survives).
  const endings = [flat.search(/[。！？]/), flat.search(/\.(?=\s|$)/)]
    .filter((index) => index >= 0)
    .map((index) => index + 1);
  const sentence = endings.length > 0 ? flat.slice(0, Math.min(...endings)).trim() : flat;
  const points = [...sentence];
  if (points.length <= cap) return sentence;
  const head = points.slice(0, cap - 1).join("");
  const cut = Math.max(
    head.lastIndexOf(" "),
    head.lastIndexOf("，"),
    head.lastIndexOf("、"),
    head.lastIndexOf("；"),
    head.lastIndexOf("："),
    head.lastIndexOf("——"),
  );
  // Only honour a word boundary in the second half; cutting at column 6 would
  // lose the meaning to save three characters.
  const body = cut > Math.floor(cap * 0.55) ? head.slice(0, cut) : head;
  return `${body.trimEnd().replace(/[，、；：—-]+$/, "")}…`;
}

/** Pick one language out of a `metaOf` field, which is a string or `{en, zh, …}`. */
function localized(value) {
  if (typeof value === "string") return value.trim() === "" ? undefined : value;
  if (typeof value !== "object" || value === null) return undefined;
  for (const language of ["zh", "en"]) {
    const entry = value[language];
    if (typeof entry === "string" && entry.trim() !== "") return entry;
  }
  for (const entry of Object.values(value)) {
    if (typeof entry === "string" && entry.trim() !== "") return entry;
  }
  return undefined;
}

/**
 * Create the metadata reader for one plugin instance.
 *
 * @param options.ctx - the plugin context; `loader` and `pluginPackages` are read
 *   through `ctx.get`.
 * @param options.logger - optional logger.
 * @param options.cap - summary length in code points.
 * @returns `{ describe(pkg), dispose() }`.
 */
export function createMetaReader(options = {}) {
  const { ctx, logger } = options;
  const cap = Number.isFinite(options.cap) ? options.cap : DEFAULT_CAP;

  /** `manifestPath` -> `{ mtimeMs, value }`. A plugin upgrade changes the mtime. */
  const cache = new Map();
  let disposed = false;

  const service = (name) => {
    try {
      const found = typeof ctx?.get === "function" ? ctx.get(name, false) : undefined;
      if (found !== undefined && found !== null) return found;
    } catch {
      /* service absent or not injectable from here */
    }
    try {
      return ctx?.[name];
    } catch {
      return undefined;
    }
  };

  const loaderEntries = () => {
    try {
      const loader = service("loader");
      return typeof loader?.entries === "function" ? [...loader.entries()] : [];
    } catch {
      return [];
    }
  };

  /**
   * Resolution anchors for one package.
   *
   * One base is not enough, and the reason is measured: a first-party package
   * lives in the harness install directory, so resolving it against the profile's
   * base fails outright for `@deepseek-ai/dsh-tool-fs` and succeeds only against
   * the base of the Loader entry that names it. Each entry therefore contributes
   * its own tree base — the same rule `dsh-host-plugin-inventory` applies.
   *
   * A subpath specifier is tried before the bare name: `readPluginMeta` never
   * reads `package.json` for a subpath, and a package that exports
   * `./<name>/locale/*.json` answers for the subpath but not for the bare name.
   */
  const anchors = (pkg) => {
    const out = [];
    const seen = new Set();
    const push = (specifier, base) => {
      const key = `${specifier}\u0000${base ?? ""}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ specifier, base });
    };
    for (const entry of loaderEntries()) {
      let name;
      try {
        name = entry?.options?.name;
      } catch {
        continue;
      }
      if (typeof name !== "string" || name === "") continue;
      if (name !== pkg && barePackageName(name) !== pkg) continue;
      let base;
      try {
        base = entry.parent?.tree?.ctx?.baseUrl;
      } catch {
        base = undefined;
      }
      if (typeof base !== "string") continue;
      push(name, base);
      if (name !== pkg) push(pkg, base);
    }
    let own;
    try {
      own = typeof ctx?.baseUrl === "string" ? ctx.baseUrl : undefined;
    } catch {
      own = undefined;
    }
    if (own !== undefined) push(pkg, own);
    if (out.length === 0) push(pkg, undefined);
    return out;
  };

  /** One (specifier, base) attempt. Answers `undefined` when this anchor knows nothing. */
  const readAt = (specifier, base) => {
    const packages = service("pluginPackages");
    if (packages === undefined || typeof packages.metaOf !== "function") return undefined;

    let info;
    try {
      info = typeof packages.packageOf === "function" ? packages.packageOf(specifier, base) : undefined;
    } catch {
      info = undefined;
    }
    const manifestPath = typeof info?.manifestPath === "string" ? info.manifestPath : undefined;
    let mtimeMs;
    if (manifestPath !== undefined) {
      try {
        mtimeMs = fs.statSync(manifestPath).mtimeMs;
      } catch {
        mtimeMs = undefined;
      }
      const hit = mtimeMs === undefined ? undefined : cache.get(manifestPath);
      if (hit !== undefined && hit.mtimeMs === mtimeMs) return hit.value;
    }

    let meta;
    try {
      meta = packages.metaOf(specifier, base);
    } catch (error) {
      logger?.debug?.(`dsh-tool-gate: metadata for ${specifier} failed (${String(error?.message ?? error)})`);
      meta = undefined;
    }

    let text = localized(meta?.description) ?? "";
    let source = text === "" ? "none" : "metaOf";
    if (text === "") {
      // Layer 2: the manifest itself. `packageOf` locates the directory through
      // Node's lookup paths rather than through `exports`, so this reaches a
      // package that exports nothing beyond `.`.
      const raw = typeof info?.manifest?.description === "string" ? info.manifest.description : "";
      if (raw.trim() !== "") {
        text = raw;
        source = "manifest";
      }
    }

    const rawTitle = localized(meta?.title);
    // A host title that is just the package name (or the specifier) says nothing
    // the reader has not already got, and using it as a label would replace
    // `GitHub` with `@perrylink/dsh-github`.
    const title = rawTitle !== undefined && rawTitle !== specifier && rawTitle !== barePackageName(specifier)
      ? rawTitle
      : undefined;

    if (text === "" && title === undefined) return undefined;

    const value = { text: summarize(text, cap), source, title };
    if (manifestPath !== undefined && mtimeMs !== undefined) cache.set(manifestPath, { mtimeMs, value });
    return value;
  };

  /**
   * Display metadata for one package.
   *
   * Never throws: a broken manifest or an absent service degrades to
   * `{ text: "", source: "none" }`, because both the settings page and the prompt
   * assembly path read this and neither may fail over a bad `package.json`.
   *
   * @param pkg - a package name, or a package subpath identity.
   * @returns `{ text, source, title? }` with `source` in `metaOf | manifest | none`.
   */
  const describe = (pkg) => {
    if (disposed || typeof pkg !== "string" || pkg === "") return { text: "", source: "none" };
    for (const anchor of anchors(pkg)) {
      let value;
      try {
        value = readAt(anchor.specifier, anchor.base);
      } catch (error) {
        logger?.debug?.(`dsh-tool-gate: metadata for ${pkg} failed (${String(error?.message ?? error)})`);
        value = undefined;
      }
      if (value !== undefined) return value;
    }
    return { text: "", source: "none" };
  };

  return {
    describe,
    dispose() {
      disposed = true;
      cache.clear();
    },
  };
}

export default { createMetaReader, summarize };
