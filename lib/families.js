import { CORE_TOOLS, CONTEXT_TOOLS } from "./keep-tools.js";
import { applyFamilyOverrides, deriveFamilies, familyIdOf, isFirstParty } from "./discovery.js";
import { NAMED_RESIDENT, nameOnlyResident } from "./resident.js";

/**
 * Family definitions and the frozen wire surface (F0).
 *
 * A family is a named bucket of tools that all collapse behind one gateway tool.
 * Membership is **derived, not enumerated**: every tool belongs to the package
 * that registered it, so one package is one family (see `discovery.js`). Nothing
 * in this file names a plugin, which is what makes the plugin work for tools that
 * did not exist when it was written.
 *
 * `cordis.patch.yml` still ships a family table, but as *overrides* — renames,
 * per-family switches, and merges. An override never has to exist for a plugin to
 * be collapsed; it only exists to change the default.
 */

const CORE = new Set(CORE_TOOLS);
const CONTEXT = new Set(CONTEXT_TOOLS);

/**
 * Names that stay on the wire regardless of attribution — the **name layer**.
 *
 * There used to be a third list here, `OPS_TOOLS`, holding seven `ops_*` names by
 * hand. It was wrong in both directions: it missed the eleven `ops_*` tools that
 * exist, so they were collapsed into a family owned by the engine package, and it
 * would have needed an edit for every future ops module. Residency for that set is
 * now derived from the owner — package `dsh-ops` plus an `ops_` prefix (see
 * `engine-packages.js:isOpsTool` and `resident.js:createResident`).
 *
 * What remains here is genuinely name-shaped: the core tools the model expects to
 * call directly, the context tools a story needs in every turn, and the user's own
 * `residentTools` pins. `extra` counts for both decisions — pinning a tool keeps it
 * on the wire *and* stops it defining a family.
 *
 * Callers that have an owner index should use `createResident()` instead; this is
 * the approximation for contexts without one (tests, early passes).
 */
export function isKeepTool(name, extra) {
  if (NAMED_RESIDENT.has(name)) return true;
  return extra !== undefined && extra.has(name);
}

/**
 * Every resident name, name layer only.
 *
 * Used as a floor for reserved ids, so a gateway can never shadow a tool. The
 * production path passes the whole registry as `reservedIds` — this list alone
 * would miss the `ops_*` names.
 */
export function residentNames(extra) {
  const names = [...CORE, ...CONTEXT];
  if (extra !== undefined) for (const name of extra) if (!names.includes(name)) names.push(name);
  return names;
}

/**
 * Resolve the family table for one assembly.
 *
 * @param configFamilies - the configured override dict.
 * @param options.owners - `{ [toolName]: packageName | "mcp:<server>" }`.
 * @param options.builtinEnabled - whether first-party packages also collapse.
 * @param options.selfPackage - this plugin's package name.
 * @param options.residentTools - extra names that must stay on the wire.
 * @param options.isResident - `(name) => boolean`, the single residency predicate
 *   (`resident.js:createResident`). Without it the name layer alone is used, which
 *   would leave the `ops_*` tools collapsed — the very bug this shape fixes.
 * @param options.reservedIds - every registered tool name; a family id may not
 *   collide with one, or the gateway would shadow a real tool.
 * @param options.specifiers - `Map<pkg, string[]>`, for config-key aliases.
 * @param options.report - sink for `{ aliasUses, orphanKeys, rejected }`, filled in
 *   place so a caller can surface it (see `diagnostics.js`) without changing the
 *   return type every existing caller destructures.
 * @param options.metadata - optional `(pkg) => { text, source }`, the family's
 *   description and where it came from (see `plugin-meta.js`).
 * @returns `{ [familyId]: family }`.
 */
export function resolveFamilies(configFamilies, options = {}) {
  const builtinEnabled = options.builtinEnabled !== false;
  const extra = new Set(Array.isArray(options.residentTools) ? options.residentTools : []);
  const nameOnly = nameOnlyResident([...extra]);
  const isResident = typeof options.isResident === "function" ? options.isResident : nameOnly;
  const report = options.report ?? { aliasUses: [], orphanKeys: [], rejected: [] };
  if (!Array.isArray(report.aliasUses)) report.aliasUses = [];
  if (!Array.isArray(report.orphanKeys)) report.orphanKeys = [];
  if (!Array.isArray(report.rejected)) report.rejected = [];
  // A gateway id must not shadow any registered tool, not merely a resident one.
  const reservedIds = Array.isArray(options.reservedIds) ? [...options.reservedIds] : [];
  for (const name of residentNames(extra)) if (!reservedIds.includes(name)) reservedIds.push(name);
  const derived = options.auto === false
    ? {}
    : deriveFamilies({
      owners: options.owners ?? {},
      builtinEnabled,
      selfPackage: options.selfPackage,
      reservedIds,
      isResident,
      specifiers: options.specifiers,
      metadata: options.metadata,
      onReject: (rejection) => report.rejected.push(rejection),
    });
  const resolved = applyFamilyOverrides(derived, configFamilies, { metadata: options.metadata, report });
  // Builtin families answer to their own switch AND the group switch.
  for (const family of Object.values(resolved)) {
    if (family.builtin === true && !builtinEnabled) family.enabled = false;
  }
  return resolved;
}

/** Gateway tool name for one family id (`gatewayPrefix` + id, or an explicit override). */
export function gatewayName(prefix, familyId, explicit) {
  if (typeof explicit === "string" && explicit !== "") return explicit;
  return typeof prefix === "string" && prefix !== "" ? `${prefix}${familyId}` : familyId;
}

/**
 * Build the resolver that maps a tool name (plus its owner) to a family id.
 *
 * @param families - resolved family table.
 * @param ownerOf - name -> package name | `mcp:<server>` | undefined.
 * @param gatewayNameFor - `(familyId) => string`; gateway tools are never members.
 * @returns `familyOf(name)` plus helpers.
 */
export function createFamilyResolver(families, ownerOf, gatewayNameFor) {
  /** name -> family id, memoized; undefined marks "resolved as none". */
  const memo = new Map();
  /** Owner name -> family id, memoized: an owner rarely spans two families. */
  const byOwner = new Map();

  const gatewayNames = new Set();
  for (const family of Object.values(families)) {
    gatewayNames.add(typeof gatewayNameFor === "function" ? gatewayNameFor(family.id) : family.id);
  }

  const familyForOwner = (owner) => {
    if (typeof owner !== "string" || owner === "") return undefined;
    if (byOwner.has(owner)) return byOwner.get(owner);
    // MCP servers: matched by the owner identity, never by package name.
    if (owner.startsWith("mcp:")) {
      for (const family of Object.values(families)) {
        if ((family.packages ?? []).includes(owner)) {
          byOwner.set(owner, family.id);
          return family.id;
        }
      }
      const mcpFamily = families.mcp_servers;
      if (mcpFamily !== undefined) {
        byOwner.set(owner, mcpFamily.id);
        return mcpFamily.id;
      }
    }
    for (const family of Object.values(families)) {
      if ((family.packages ?? []).includes(owner)) {
        byOwner.set(owner, family.id);
        return family.id;
      }
    }
    byOwner.set(owner, undefined);
    return undefined;
  };

  const memberOf = (name, owner) => {
    if (gatewayNames.has(name)) return undefined;
    // Explicit name lists win: a configured family may carve tools out of a
    // package whose other tools must stay resident.
    for (const family of Object.values(families)) {
      if ((family.tools ?? []).includes(name)) return family.id;
    }
    const byPackage = familyForOwner(owner);
    if (byPackage !== undefined) return byPackage;
    for (const family of Object.values(families)) {
      if ((family.prefixes ?? []).some((prefix) => prefix !== "" && name.startsWith(prefix))) return family.id;
    }
    return undefined;
  };

  const familyOf = (name) => {
    if (typeof name !== "string" || name === "") return undefined;
    if (memo.has(name)) return memo.get(name);
    const family = memberOf(name, ownerOf(name));
    memo.set(name, family);
    return family;
  };

  return {
    familyOf,
    /** Family ids that currently have at least one member in `names`. */
    activeIn(names) {
      const seen = new Set();
      for (const name of names) {
        const family = familyOf(name);
        if (family !== undefined) seen.add(family);
      }
      return seen;
    },
    /** Drop memoized lookups (a family table change makes old answers stale). */
    reset() {
      memo.clear();
      byOwner.clear();
    },
  };
}

/**
 * Compute the frozen wire surface.
 *
 * The result is an ordered array of schema objects taken by reference from the
 * assembled list, so repeated calls that see the same input return byte-identical
 * JSON. Ordering is code-unit by name, matching what `dsh-system-prompt` does
 * before it hands tools to the provider.
 *
 * @param tools - `assembly.tools` as produced by every other listener.
 * @param options.familyOf - name -> family id | undefined.
 * @param options.families - resolved family table (for `enabled`).
 * @param options.alwaysExpose - names forced onto the wire.
 * @param options.alwaysHide - names forced off the wire.
 * @param options.unknownOwnerPolicy - "expose" | "collapse".
 * @param options.keepNames - extra names to keep (gateway tools themselves).
 * @param options.residentTools - user-pinned names that must stay on the wire.
 * @param options.isResident - `(name) => boolean`, the residency predicate. It has
 *   to be the same one family discovery used: a name that is resident there must
 *   not be collapsed here, or the plugin would report a tool as both hidden and
 *   resident.
 * @param options.collapsibleFamilies - the set of family ids that may be collapsed
 *   at all (`degenerate.js`). Undefined means "no opinion" — every enabled family
 *   is collapsible, which is the old behaviour and the safe one for callers that
 *   have no member sizes.
 * @returns the filtered, ordered schema array plus a per-family breakdown.
 */
export function buildFrozenSurface(tools, options) {
  const { familyOf, families, alwaysExpose, alwaysHide, unknownOwnerPolicy, keepNames } = options;
  const expose = new Set(alwaysExpose ?? []);
  const hide = new Set(alwaysHide ?? []);
  const keep = keepNames instanceof Set ? keepNames : new Set(keepNames ?? []);
  const allowFamilies = options.collapsibleFamilies instanceof Set ? options.collapsibleFamilies : undefined;
  const extra = new Set(Array.isArray(options.residentTools) ? options.residentTools : []);
  const residentOf = typeof options.isResident === "function"
    ? options.isResident
    : (name) => isKeepTool(name, extra);
  const collapsed = [];
  const kept = [];

  for (const schema of tools ?? []) {
    const name = schema?.name;
    if (typeof name !== "string" || name === "") continue;
    if (expose.has(name)) {
      kept.push(schema);
      continue;
    }
    if (hide.has(name)) {
      collapsed.push(name);
      continue;
    }
    if (keep.has(name) || residentOf(name)) {
      kept.push(schema);
      continue;
    }
    const family = familyOf(name);
    if (family === undefined) {
      // Unknown owner: exposing is the safe default ("rather save less than lose a tool").
      if (unknownOwnerPolicy === "collapse") collapsed.push(name);
      else kept.push(schema);
      continue;
    }
    const definition = families[family];
    if (definition === undefined || definition.enabled === false) {
      kept.push(schema);
      continue;
    }
    // A family that cannot pay for its gateway collapses nothing: hiding one member
    // behind a gateway that costs as much as it saves is a net loss, and it is not
    // even reachable — `withheldFamilyIds` keeps that gateway off the wire, so the
    // "hidden only when its gateway rides this wire" rule would fail anyway.
    if (allowFamilies !== undefined && !allowFamilies.has(family)) {
      kept.push(schema);
      continue;
    }
    collapsed.push(name);
  }

  kept.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { tools: kept, collapsed };
}

export { familyIdOf, isFirstParty };
