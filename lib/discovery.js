/**
 * Family discovery — the partition is *derived*, never enumerated.
 *
 * The rule is one sentence long: **one plugin package is one family**. Every tool
 * belongs to the package that registered it (see `owner.js`), so the grouping
 * falls out of the registry instead of out of a table in this repository. Install
 * a new plugin and its tools collapse behind their own gateway on the next
 * assembly, with no edit here.
 *
 * That single rule replaces the previous hand-written table of eight families,
 * which had to be edited for every plugin and silently left new plugins exposed.
 *
 * Two derived exceptions, both rules rather than lists:
 *
 *  - `mcp__<server>__<tool>` names belong to a server, not a package. They group
 *    into one family (`mcp_servers`), because an MCP server ships no code here and
 *    one gateway per server would multiply the resident tool count.
 *  - A package whose tools are *all* resident (the core/OPS/context sets) needs no
 *    family: there is nothing left to hide. This is why most first-party packages
 *    produce no gateway while `dsh-tool-session-query` and `dsh-tool-schedule` do
 *    — their tools are optional, so they collapse.
 *
 * `lib/family-labels.js` derives the display name from the package name
 * (`@perrylink/dsh-github` → `Github`, `dsh-blender-plugin` → `Blender Plugin`).
 * Labels never affect membership, and they are presentation only: the gateway's
 * wire name is the family id, so renaming a family can never move the prefix.
 */

import { CORE_TOOLS, CONTEXT_TOOLS, OPS_TOOLS } from "./keep-tools.js";
import { familyLabelHints } from "./family-labels.js";
import { UNKNOWN } from "./owner.js";

/** Resident names — a tool that always stays on the wire defines no family. */
const RESIDENT = new Set([...CORE_TOOLS, ...OPS_TOOLS, ...CONTEXT_TOOLS]);

/** Prefix for tool names exposed by an MCP server rather than a package. */
const MCP_TOOL_PREFIX = "mcp__";

/** Owner identity prefix for MCP servers (`mcp:<server>`). */
const MCP_OWNER_PREFIX = "mcp:";

/** The family that collects MCP server tools; it has no package of its own. */
export const MCP_SERVERS_FAMILY = "mcp_servers";

/**
 * Scopes and name prefixes that mark first-party code.
 *
 * Defined once in `ownership-channel.js`; re-exported here because family
 * discovery is where the decision is made. It used to be spelled out three
 * times — here, in `index.js` and inline in `bridge.js` — and two of the copies
 * disagreed about whether `@dsh-ops/` counted.
 */
import { HARNESS_PACKAGE_PREFIXES, isHarnessPackage } from "./ownership-channel.js";

export { HARNESS_PACKAGE_PREFIXES, isHarnessPackage as isFirstParty };

/** Whether a package name belongs to the harness itself. */
const isFirstParty = isHarnessPackage;

/**
 * Turn a package name into a tool-safe family id.
 *
 * `@perrylink/dsh-github` → `github`, `dsh-tool-session-query` → `session_query`,
 * `@vectorize-io/hindsight-coding-agents` → `hindsight_coding_agents`.
 *
 * Deterministic on purpose: the gateway tool name is part of the wire surface, so
 * the same package must always yield the same id or the prefix would churn.
 */
export function familyIdOf(pkg) {
  let name = pkg;
  const slash = name.lastIndexOf("/");
  if (slash >= 0) name = name.slice(slash + 1);
  for (const prefix of ["dsh-tool-", "dsh-plugin-", "dsh-", "plugin-"]) {
    if (name.startsWith(prefix) && name.length > prefix.length) {
      name = name.slice(prefix.length);
      break;
    }
  }
  const sanitized = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return sanitized === "" ? "family" : sanitized;
}

/** Make an id unique against everything already taken. */
function uniqueId(base, taken) {
  if (!taken.has(base)) {
    taken.add(base);
    return base;
  }
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base}${index}`;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
  throw new Error(`dsh-tool-gate: cannot derive a unique family id for ${base}`);
}

/** One family record, in the shape the rest of the plugin expects. */
function makeFamily(id, pkg, options) {
  const meta = typeof options.metadata === "function" ? options.metadata(pkg) : undefined;
  const hints = familyLabelHints(id, pkg);
  const described = typeof meta?.text === "string" && meta.text !== "";
  return {
    id,
    // The package name, capitalised — never a translated capability word and
    // never the host's locale title. A user who wants `GitHub` writes
    // `families.github.label: GitHub`; nothing else can silently override it.
    label: hints.label,
    /**
     * Where `description` came from, for the settings page: `"metaOf"` and
     * `"manifest"` are the host, `"override"` is the user's own config, `"none"`
     * is nothing at all.
     *
     * Not decoration: a family whose sentence came from somewhere other than its
     * own manifest is exactly what the page needs to show, and there is no
     * fallback table left to answer instead.
     */
    descriptionSource: described ? meta.source : "none",
    description: described ? meta.text : "",
    enabled: true,
    /** True for a family derived from the registry rather than configured. */
    auto: true,
    /** First-party packages are the ones the "builtin tools too" switch gates. */
    builtin: isFirstParty(pkg),
    packages: pkg === undefined ? [] : [pkg],
    prefixes: [],
    tools: [],
  };
}

/**
 * Derive the family table from a live ownership snapshot.
 *
 * @param options.owners - `{ [toolName]: packageName | "mcp:<server>" }`, as
 *   reported by the owner index.
 * @param options.builtinEnabled - when false, first-party packages are not
 *   collapsed (their tools stay on the wire) and no family is created for them.
 * @param options.selfPackage - this plugin's own package name, always skipped.
 * @param options.reservedIds - ids that must not be used (resident tool names,
 *   so a gateway can never shadow a real tool).
 * @param options.resident - extra names that must stay on the wire, on top of the
 *   built-in CORE/OPS/CONTEXT sets. `residentTools` in the config lands here, so a
 *   user can pin a tool without editing this package.
 * @param options.metadata - `(pkg) => { text?, source?, title? }`, the host's
 *   plugin metadata (see `plugin-meta.js`). It is the **only** description
 *   source: when it answers, the family carries its text; when it does not, the
 *   family carries `""` and the source reads `"none"`. There is no code-side
 *   fallback table any more — an invented sentence cannot go stale with the
 *   package, but it also cannot be right about it.
 * @returns `{ [familyId]: family }`, sorted by id for stable iteration.
 */
export function deriveFamilies(options) {
  const { owners, builtinEnabled = true, selfPackage, reservedIds } = options;
  const resident = options.resident instanceof Set ? options.resident : RESIDENT;
  // `reservedIds` holds ids a caller already claimed; the production path always
  // passes it, but requiring it makes the function needlessly easy to call wrong.
  const taken = new Set(reservedIds ?? []);
  const byPackage = new Map();

  for (const [toolName, pkg] of Object.entries(owners ?? {})) {
    if (typeof toolName !== "string" || toolName === "") continue;
    if (typeof pkg !== "string" || pkg === "" || pkg === UNKNOWN) continue;
    if (selfPackage !== undefined && pkg === selfPackage) continue;
    if (pkg.startsWith(MCP_OWNER_PREFIX)) continue; // grouped separately below
    if (resident.has(toolName)) continue; // resident tools define no family
    let row = byPackage.get(pkg);
    if (row === undefined) {
      row = { pkg, tools: [] };
      byPackage.set(pkg, row);
    }
    row.tools.push(toolName);
  }

  const families = {};

  for (const pkg of [...byPackage.keys()].sort()) {
    // A package whose every tool is resident never enters `byPackage` at all (the
    // collection loop above drops resident names), so it defines no family and no
    // gateway — which is exactly right: there would be nothing behind the gateway.
    const thirdParty = !isFirstParty(pkg);
    if (!thirdParty && !builtinEnabled) continue;
    const id = uniqueId(familyIdOf(pkg), taken);
    families[id] = makeFamily(id, pkg, options);
  }

  // MCP servers: one family for all of them, matched by name prefix.
  const mcpServers = new Set();
  for (const [toolName, pkg] of Object.entries(owners ?? {})) {
    if (typeof pkg !== "string" || !pkg.startsWith(MCP_OWNER_PREFIX)) continue;
    if (!toolName.startsWith(MCP_TOOL_PREFIX)) continue;
    // `mcp__<server>__<tool>`: derive the server list instead of naming servers
    // in a table that would have to be edited on every connection.
    const server = toolName.split("__")[1];
    if (typeof server === "string" && server !== "") mcpServers.add(server);
  }
  if (mcpServers.size > 0) {
    const id = uniqueId(MCP_SERVERS_FAMILY, taken);
    const servers = [...mcpServers].sort();
    // `mcp_servers` is a pseudo-family: there is no package to describe it, and
    // the one sentence it does have is derived from the server names, so it is
    // the only family whose description is written here.
    families[id] = {
      id,
      ...familyLabelHints(id, undefined),
      description: servers.length === 0 ? "" : `由 MCP 服务器提供：${servers.join("、")}`,
      descriptionSource: servers.length === 0 ? "none" : "derived",
      enabled: true,
      auto: true,
      builtin: false,
      packages: [],
      prefixes: [MCP_TOOL_PREFIX],
      tools: [],
    };
  }

  return families;
}

/**
 * Apply user overrides on top of the derived table.
 *
 * An override does three things, none of which reintroduces a code-side list:
 *
 *  - patches a derived family (`enabled`, `label`, `description`, `gateway`);
 *  - claims packages for a new family, merging several plugins behind one gateway;
 *  - names a family explicitly (`tools`), for a caller who wants that instead.
 *
 * A package claimed by an override is removed from its derived family, so the
 * same tool is never in two families.
 *
 * @param derived - output of `deriveFamilies`.
 * @param overrides - the configured `families` dict.
 * @param options.metadata - optional `(pkg) => { text?, source? }`, used only to
 *   fill in the description of a family the config *creates*.
 * @returns the resolved table.
 */
export function applyFamilyOverrides(derived, overrides, options = {}) {
  const out = {};
  for (const [id, family] of Object.entries(derived)) {
    out[id] = { ...family, packages: [...family.packages], prefixes: [...family.prefixes], tools: [...family.tools] };
  }
  if (overrides === undefined || overrides === null) return out;

  const claimed = new Map(); // package -> family id

  for (const [rawId, patch] of Object.entries(overrides)) {
    if (patch === undefined || patch === null || typeof patch !== "object") continue;
    const id = String(rawId);
    const target = out[id];
    if (target === undefined) {
      // A new family: only meaningful when it names something to hold.
      const packages = Array.isArray(patch.packages) ? patch.packages.filter((e) => typeof e === "string" && e !== "") : [];
      const tools = Array.isArray(patch.tools) ? patch.tools.filter((e) => typeof e === "string" && e !== "") : [];
      if (packages.length === 0 && tools.length === 0) continue; // stale id: ignore
      const meta = typeof options?.metadata === "function" ? options.metadata(packages[0]) : undefined;
      const described = typeof meta?.text === "string" && meta.text !== "";
      out[id] = {
        id,
        ...familyLabelHints(id, packages[0]),
        description: described ? meta.text : "",
        descriptionSource: described ? meta.source : "none",
        enabled: patch.enabled !== false,
        auto: false,
        builtin: packages.length > 0 && packages.every((pkg) => isFirstParty(pkg)),
        packages,
        prefixes: Array.isArray(patch.prefixes) ? patch.prefixes.filter((e) => typeof e === "string" && e !== "") : [],
        tools,
      };
      // The same overrides a *derived* family accepts, or a family the config is
      // the sole author of could not be named, described or given a short gateway
      // name at all — and config outranks every derived value, so it has to work
      // the same on both paths.
      if (typeof patch.label === "string" && patch.label !== "") out[id].label = patch.label;
      if (typeof patch.description === "string" && patch.description !== "") {
        out[id].description = patch.description;
        out[id].descriptionSource = "override";
      }
      if (typeof patch.gateway === "string" && patch.gateway !== "") out[id].gateway = patch.gateway;
      for (const pkg of packages) claimed.set(pkg, id);
      continue;
    }
    if (typeof patch.enabled === "boolean") target.enabled = patch.enabled;
    if (typeof patch.label === "string" && patch.label !== "") target.label = patch.label;
    if (typeof patch.description === "string" && patch.description !== "") {
      target.description = patch.description;
      target.descriptionSource = "override";
    }
    if (typeof patch.gateway === "string" && patch.gateway !== "") target.gateway = patch.gateway;
    if (Array.isArray(patch.packages) && patch.packages.length > 0) {
      const packages = patch.packages.filter((entry) => typeof entry === "string" && entry !== "");
      target.packages = packages;
      for (const pkg of packages) claimed.set(pkg, id);
    }
    if (Array.isArray(patch.tools) && patch.tools.length > 0) {
      target.tools = patch.tools.filter((entry) => typeof entry === "string" && entry !== "");
    }
    if (Array.isArray(patch.prefixes) && patch.prefixes.length > 0) {
      target.prefixes = patch.prefixes.filter((entry) => typeof entry === "string" && entry !== "");
    }
    // An override that explicitly keeps a family off the wire would otherwise
    // still claim its packages; claiming is what removes them from elsewhere.
    for (const pkg of target.packages) {
      if (!claimed.has(pkg)) claimed.set(pkg, id);
    }
  }

  // A package claimed by another family leaves the family it was derived into.
  for (const [id, family] of Object.entries(out)) {
    family.packages = family.packages.filter((pkg) => {
      const owner = claimed.get(pkg);
      return owner === undefined || owner === id;
    });
  }

  // A derived family that lost every member to a merge is noise in the UI.
  for (const [id, family] of Object.entries(out)) {
    if (family.auto === true && family.packages.length === 0 && family.prefixes.length === 0 && family.tools.length === 0) {
      delete out[id];
    }
  }

  return out;
}
