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
 *  - A package whose tools are *all* resident needs no family: there is nothing
 *    left to hide. This is why most first-party packages produce no gateway while
 *    `dsh-tool-session-query` and `dsh-tool-schedule` do — their tools are
 *    optional, so they collapse.
 *
 * ## Four identifiers, four jobs
 *
 * One package used to yield *one string* that served as the family id, the wire
 * tool name, the settings-page title and the config key. That is why a plugin
 * package called `dsh-tool-subagent` became a gateway called `subagent2`, a config
 * key `families.subagent2` and a card titled `Subagent`, and why a Loader entry
 * named `@vectorize-io/hindsight-coding-agents/dsh` produced a family called `dsh`
 * whose config key nobody could guess.
 *
 * They are separated now, and only the last three are ever shown to someone:
 *
 * | field       | example                | unique against                    | seen by |
 * | ----------- | ---------------------- | --------------------------------- | ------- |
 * | `id`        | `subagent_tools`       | every other family id and tool    | diagnostics only |
 * | `wire`      | `subagent_tools`       | every tool name (a gateway is one)| the model |
 * | `label`     | `Subagent（…）`        | other labels and tool names       | the user |
 * | `configKey` | `subagent_tools`       | — (aliases fall back to it)       | the user |
 *
 * A number is never part of any of them: `uniqueId` used to append `2`, `3`, … to
 * resolve a collision, which leaked into the wire name. A collision is now
 * resolved semantically, and a package with no clean name simply does not become a
 * family (see `disambiguateId`).
 *
 * `lib/family-labels.js` derives the display name from the package name
 * (`@perrylink/dsh-github` → `Github`, `dsh-blender-plugin` → `Blender Plugin`).
 * Labels never affect membership, and they are presentation only: the gateway's
 * wire name is the family id, so renaming a family can never move the prefix.
 */

import { CONTEXT_TOOLS } from "./keep-tools.js";
import { familyLabelHints } from "./family-labels.js";
import { UNKNOWN } from "./owner.js";
import { nameOnlyResident } from "./resident.js";
import { canonicalPackage } from "./ownership-channel.js";

/** Resident names used when the caller supplies no predicate (tests, first pass). */
const DEFAULT_RESIDENT = nameOnlyResident();

/** The suffix a colliding base id is qualified with (`subagent` → `subagent_tools`). */
export const ID_SUFFIX = "_tools";

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

/** Turn any string into a tool-safe identifier. */
function sanitize(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Turn a package name into a tool-safe family id.
 *
 * `@perrylink/dsh-github` → `github`, `dsh-tool-session-query` → `session_query`,
 * `@vectorize-io/hindsight-coding-agents` → `hindsight_coding_agents`.
 *
 * Deterministic on purpose: the gateway tool name is part of the wire surface, so
 * the same package must always yield the same id or the prefix would churn.
 *
 * It takes a **package name**, never a module specifier — `canonicalPackage()`
 * has already dropped the subpath by the time a family is named.
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
  const sanitized = sanitize(name);
  return sanitized === "" ? "family" : sanitized;
}

/** The npm scope as an id fragment: `@deepseek-ai/x` → `deepseek_ai`. */
function scopeIdOf(pkg) {
  if (typeof pkg !== "string" || !pkg.startsWith("@")) return undefined;
  const end = pkg.indexOf("/");
  if (end < 0) return undefined;
  const scope = sanitize(pkg.slice(1, end));
  return scope === "" ? undefined : scope;
}

/**
 * Resolve a family id that cannot collide with a tool name or another family.
 *
 * The old resolver appended `2`, `3`, … and stopped there — which "worked", in
 * that the registry accepted the name, and failed at everything a reader cares
 * about: `subagent2` was the wire name, the config key, the page id, and it meant
 * nothing.
 *
 * Three attempts, all semantic, none numeric:
 *
 *  1. the plain id (`subagent`),
 *  2. the id qualified with a domain suffix (`subagent_tools`),
 *  3. the id qualified with the npm scope (`deepseek_ai_subagent`).
 *
 * Still taken ⇒ `undefined`: the package does not become a family at all. Its
 * tools stay on the wire, which costs tokens and loses nothing — and the caller
 * gets the reason (`id-collision`) in the diagnostics instead of a mystery id.
 *
 * @param base - `familyIdOf(pkg)`.
 * @param pkg - the owning package, for the scope-qualified fallback.
 * @param taken - everything already claimed; the chosen id is added to it.
 * @returns the id, or `undefined` when every candidate is taken.
 */
export function disambiguateId(base, pkg, taken) {
  const claim = (candidate) => {
    if (taken.has(candidate)) return undefined;
    taken.add(candidate);
    return candidate;
  };
  const direct = claim(base);
  if (direct !== undefined) return direct;
  const suffixed = claim(`${base}${ID_SUFFIX}`);
  if (suffixed !== undefined) return suffixed;
  const scope = scopeIdOf(pkg);
  if (scope !== undefined) return claim(`${scope}_${base}`);
  return undefined;
}

/**
 * Config keys this family has answered to.
 *
 * A family id is a *wire* name now, so it is derived from the package and not from
 * a Loader entry. Two things change it over time, and a user's `familes:` entry has
 * to survive both:
 *
 *  - the entry a package is mounted under (`…/dsh` used to name the family `dsh`),
 *    so every specifier the package was seen with yields an alias;
 *  - the numeric suffix the old resolver appended (`subagent2`, `subagent3`, …),
 *    recognized here and never created again.
 *
 * Aliases are read-only compatibility: an alias never becomes a wire name, and a
 * key that matches both an id and an alias resolves to the id (see
 * `applyFamilyOverrides`).
 */
function aliasesOf(pkg, id, specifiers) {
  const out = [];
  const push = (value) => {
    const candidate = typeof value === "string" ? value.trim() : "";
    if (candidate === "" || candidate === id || out.includes(candidate)) return;
    out.push(candidate);
  };
  const base = familyIdOf(pkg);
  push(base);
  const scope = scopeIdOf(pkg);
  if (scope !== undefined) push(`${scope}_${base}`);
  for (const alias of [`${base}${ID_SUFFIX}`]) push(alias);
  const seen = typeof specifiers?.get === "function" ? specifiers.get(pkg) ?? [] : [];
  for (const specifier of seen) {
    const canonical = canonicalPackage(specifier);
    if (canonical !== undefined) push(familyIdOf(canonical.pkg));
    push(familyIdOf(String(specifier).split("/").pop() ?? ""));
  }
  // The numeric ids the old resolver could have produced for this base. Recognized
  // only — nothing writes them any more.
  for (let index = 2; index <= 9; index += 1) push(`${base}${index}`);
  return out;
}

/** One family record, in the shape the rest of the plugin expects. */
function makeFamily(id, pkg, options) {
  const meta = typeof options.metadata === "function" ? options.metadata(pkg) : undefined;
  const hints = familyLabelHints(id, pkg);
  const described = typeof meta?.text === "string" && meta.text !== "";
  return {
    id,
    /**
     * The wire name. Always the id today — `gatewayName()` returns it unless the
     * user configured a `gateway:` override — but kept as its own field so the two
     * can never be confused again.
     */
    wire: id,
    /** The id before disambiguation, kept for labels, aliases and diagnostics. */
    baseId: familyIdOf(pkg),
    /**
     * The package name, capitalised — never a translated capability word and
     * never the host's locale title. A user who wants `GitHub` writes
     * `families.github.label: GitHub`; nothing else can silently override it.
     */
    label: hints.label,
    /** Set when the label had to be qualified to stay unique (see `dedupeLabels`). */
    labelQualifier: undefined,
    /** Config keys this family still answers to (see `aliasesOf`). */
    aliases: aliasesOf(pkg, id, options.specifiers),
    /**
     * Where `description` came from, for the settings page: `"metaOf"` and
     * `"manifest"` are the host, `"override"` is the user's own config, `"none"`
     * is nothing at all.
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
 * Make every label unique, without touching a single membership decision.
 *
 * `Subagent` (family of `dsh-tool-subagent`) and `subagent` (a resident tool the
 * model calls directly) read as the same thing on a page, and two families can
 * legitimately derive the same capitalised name from different packages. A label
 * is presentation, so qualifying it is safe: `Subagent（dsh-tool-subagent）`.
 *
 * @param families - table to fix in place.
 * @param reserved - normalised names that may not be used (resident tool names).
 */
function dedupeLabels(families, reserved) {
  const taken = new Set(reserved ?? []);
  for (const family of Object.values(families).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const key = String(family.label ?? family.id).toLowerCase().replace(/[\s_-]+/g, "");
    if (!taken.has(key)) {
      taken.add(key);
      continue;
    }
    const qualifier = family.packages?.[0] ?? family.id;
    family.label = `${family.label}（${qualifier}）`;
    family.labelQualifier = qualifier;
    taken.add(String(family.label).toLowerCase().replace(/[\s_-]+/g, ""));
  }
}

/**
 * Derive the family table from a live ownership snapshot.
 *
 * @param options.owners - `{ [toolName]: packageName | "mcp:<server>" }`, as
 *   reported by the owner index.
 * @param options.builtinEnabled - when false, first-party packages are not
 *   collapsed (their tools stay on the wire) and no family is created for them.
 * @param options.selfPackage - this plugin's own package name, always skipped.
 * @param options.reservedIds - ids that must not be used (resident tool names and
 *   every registered tool name, so a gateway can never shadow a real tool).
 * @param options.isResident - the single residency predicate (see `resident.js`).
 *   Without it a name-only approximation is used, which classifies the core and
 *   context sets and nothing else.
 * @param options.resident - legacy alias for user-pinned names, folded into the
 *   name-only predicate when no `isResident` is supplied.
 * @param options.specifiers - `Map<pkg, string[]>`, Loader specifiers per package,
 *   used for config-key aliases.
 * @param options.onReject - `({ pkg, base, reason }) => void`, called for a package
 *   that cannot become a family (its id collides with a tool name).
 * @param options.metadata - `(pkg) => { text?, source?, title? }`, the host's
 *   plugin metadata (see `plugin-meta.js`). It is the **only** description
 *   source: when it answers, the family carries its text; when it does not, the
 *   family carries `""` and the source reads `"none"`.
 * @returns `{ [familyId]: family }`, sorted by id for stable iteration.
 */
export function deriveFamilies(options) {
  const { owners, builtinEnabled = true, selfPackage, reservedIds } = options;
  const isResident = typeof options.isResident === "function"
    ? options.isResident
    : nameOnlyResident(options.resident instanceof Set ? [...options.resident] : []);
  // `reservedIds` holds ids a caller already claimed; the production path always
  // passes it, but requiring it makes the function needlessly easy to call wrong.
  const taken = new Set(reservedIds ?? []);
  const byPackage = new Map();

  for (const [toolName, pkg] of Object.entries(owners ?? {})) {
    if (typeof toolName !== "string" || toolName === "") continue;
    if (typeof pkg !== "string" || pkg === "" || pkg === UNKNOWN) continue;
    if (selfPackage !== undefined && pkg === selfPackage) continue;
    if (pkg.startsWith(MCP_OWNER_PREFIX)) continue; // grouped separately below
    if (isResident(toolName)) continue; // resident tools define no family
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
    const base = familyIdOf(pkg);
    const id = disambiguateId(base, pkg, taken);
    if (id === undefined) {
      // No clean name left. The package keeps its tools on the wire and the page
      // says why — the alternative was a memory-only numeric key that leaked.
      options.onReject?.({ pkg, base, reason: "id-collision" });
      continue;
    }
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
    const id = disambiguateId(MCP_SERVERS_FAMILY, undefined, taken) ?? MCP_SERVERS_FAMILY;
    const servers = [...mcpServers].sort();
    // `mcp_servers` is a pseudo-family: there is no package to describe it, and
    // the one sentence it does have is derived from the server names, so it is
    // the only family whose description is written here.
    families[id] = {
      id,
      wire: id,
      baseId: MCP_SERVERS_FAMILY,
      ...familyLabelHints(id, undefined),
      labelQualifier: undefined,
      aliases: id === MCP_SERVERS_FAMILY ? [] : [MCP_SERVERS_FAMILY],
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

  // Labels last: qualification depends on what every other family and every
  // resident tool is called, so it cannot be decided per package.
  const reservedLabels = [];
  for (const name of Object.keys(owners ?? {})) {
    if (isResident(name)) reservedLabels.push(name.toLowerCase().replace(/[\s_-]+/g, ""));
  }
  dedupeLabels(families, reservedLabels);

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
 * A key that matches **no family id** is no longer dropped in silence. It is
 * resolved through the families' aliases (`families.dsh` → `hindsight_coding_agents`,
 * `families.subagent2` → `subagent_tools`), and when that fails too it is reported
 * to `options.report.orphanKeys` — a config key that does nothing is the one bug a
 * user cannot see for themselves.
 *
 * @param derived - output of `deriveFamilies`.
 * @param overrides - the configured `families` dict.
 * @param options.metadata - optional `(pkg) => { text?, source? }`, used only to
 *   fill in the description of a family the config *creates*.
 * @param options.report - optional sink: `{ aliasUses: [], orphanKeys: [] }`.
 * @returns the resolved table.
 */
export function applyFamilyOverrides(derived, overrides, options = {}) {
  const out = {};
  for (const [id, family] of Object.entries(derived)) {
    out[id] = {
      ...family,
      packages: [...family.packages],
      prefixes: [...family.prefixes],
      tools: [...family.tools],
      aliases: [...(family.aliases ?? [])],
    };
  }
  const report = options.report ?? { aliasUses: [], orphanKeys: [] };
  if (overrides === undefined || overrides === null) return out;

  /** alias -> family id, for keys that are not themselves a family id. */
  const aliasIndex = new Map();
  for (const family of Object.values(out)) {
    for (const alias of family.aliases ?? []) {
      if (out[alias] !== undefined) continue;
      if (!aliasIndex.has(alias)) aliasIndex.set(alias, family.id);
    }
  }

  const claimed = new Map(); // package -> family id

  for (const [rawId, patch] of Object.entries(overrides)) {
    if (patch === undefined || patch === null || typeof patch !== "object") continue;
    const id = String(rawId);
    let target = out[id];
    if (target === undefined) {
      const aliased = aliasIndex.get(id);
      if (aliased !== undefined) {
        target = out[aliased];
        report.aliasUses.push({ key: id, family: aliased });
      }
    }
    if (target === undefined) {
      // A new family: only meaningful when it names something to hold.
      const packages = Array.isArray(patch.packages) ? patch.packages.filter((e) => typeof e === "string" && e !== "") : [];
      const tools = Array.isArray(patch.tools) ? patch.tools.filter((e) => typeof e === "string" && e !== "") : [];
      if (packages.length === 0 && tools.length === 0) {
        // No family, no package, no tool: this key can never do anything.
        report.orphanKeys.push(id);
        continue;
      }
      const meta = typeof options?.metadata === "function" ? options.metadata(packages[0]) : undefined;
      const described = typeof meta?.text === "string" && meta.text !== "";
      out[id] = {
        id,
        wire: id,
        baseId: id,
        ...familyLabelHints(id, packages[0]),
        labelQualifier: undefined,
        aliases: [],
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
      if (Array.isArray(patch.aliases)) out[id].aliases = patch.aliases.filter((e) => typeof e === "string" && e !== "");
      for (const pkg of packages) claimed.set(pkg, id);
      continue;
    }
    if (typeof patch.enabled === "boolean") target.enabled = patch.enabled;
    if (patch.force === true) target.force = true;
    if (typeof patch.label === "string" && patch.label !== "") target.label = patch.label;
    if (typeof patch.description === "string" && patch.description !== "") {
      target.description = patch.description;
      target.descriptionSource = "override";
    }
    if (typeof patch.gateway === "string" && patch.gateway !== "") target.gateway = patch.gateway;
    if (Array.isArray(patch.aliases)) {
      for (const alias of patch.aliases) {
        if (typeof alias !== "string" || alias === "" || alias === target.id) continue;
        if (!target.aliases.includes(alias)) target.aliases.push(alias);
      }
    }
    if (Array.isArray(patch.packages) && patch.packages.length > 0) {
      const packages = patch.packages.filter((entry) => typeof entry === "string" && entry !== "");
      target.packages = packages;
      for (const pkg of packages) claimed.set(pkg, target.id);
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
      if (!claimed.has(pkg)) claimed.set(pkg, target.id);
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
