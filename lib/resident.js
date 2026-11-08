/**
 * The one place that decides whether a tool is resident (always on the wire).
 *
 * "Resident" is load-bearing in four places that used to each answer it in their
 * own way, and the disagreement was a bug with a face: the settings page said a
 * family held 18 tools worth 7133 tokens, while 11 of them could not be collapsed
 * at all, and the other 7 already sat on the wire. Two of the four places read a
 * hand-written name list; the third read nothing; the fourth had no such check.
 *
 * So there is exactly one predicate, and every consumer takes it as an option:
 *
 *  1. `discovery.js` — does this package define a family at all?
 *  2. `families.js`  — is this member withheld from the wire?
 *  3. `bridge.js`    — how many members can actually be saved, and how many tokens?
 *  4. `degenerate.js`— is there enough left behind a gateway to be worth it?
 *
 * The rules are derived, not enumerated, so a tool nobody has seen yet is still
 * classified correctly:
 *
 *  - **user pins** — the only hand-written layer a user controls;
 *  - **core names** — the harness's own tools, registered from the root context,
 *    which reports no owning package. A name list is unavoidable here and it is
 *    the *safe* direction: a stale entry keeps a tool on the wire;
 *  - **engine packages** — machinery hosts other packages' tools; its own are
 *    needed every turn;
 *  - **`ops_*` owned by `dsh-ops`** — the native file and shell set. The prefix
 *    plus the owner is the rule; the old hand-written list of seven was stale by
 *    eleven tools, which is exactly what produced the half-collapsed family;
 *  - **context packages** — `compress`/`acp_cache` and friends are needed on every
 *    turn, so a gateway in front of them would be paid for and never used.
 */

import { CORE_TOOLS, CONTEXT_TOOLS } from "./keep-tools.js";
import { isContextPackage, isEnginePackage, isOpsTool } from "./engine-packages.js";

/**
 * Names that stay on the wire with no ownership evidence at all.
 *
 * CORE: harness tools registered from the root context — the registry answers
 * "no package", so the name is the only identity they have.
 * CONTEXT: kept as a name layer as well, because a context tool whose owner could
 * not be read must still not disappear behind a gateway.
 */
export const NAMED_RESIDENT = new Set([...CORE_TOOLS, ...CONTEXT_TOOLS]);

/**
 * Build the resident predicate for one snapshot.
 *
 * @param options.ownerOf - `name => packageName | "mcp:<server>" | undefined`.
 * @param options.pins - the user's `residentTools` list.
 * @returns `(name) => boolean`.
 */
export function createResident(options = {}) {
  const ownerOf = typeof options.ownerOf === "function" ? options.ownerOf : undefined;
  const pins = new Set(Array.isArray(options.pins) ? options.pins : []);

  return (name) => {
    if (typeof name !== "string" || name === "") return false;
    if (pins.has(name)) return true;
    if (NAMED_RESIDENT.has(name)) return true;
    if (ownerOf === undefined) return false;
    const owner = ownerOf(name);
    if (typeof owner !== "string" || owner === "") return false;
    if (isEnginePackage(owner)) return true;
    if (isOpsTool(name, owner)) return true;
    if (isContextPackage(owner)) return true;
    return false;
  };
}

/**
 * Name-only fallback, for callers that have no owner snapshot (unit tests, and the
 * first assembly before attribution has run). Deliberately conservative: it knows
 * the core and context sets and nothing else, so an unknown tool is treated as
 * collapsible only when a family exists for it — which cannot happen without an
 * owner either.
 */
export function nameOnlyResident(pins) {
  const extra = new Set(Array.isArray(pins) ? pins : []);
  return (name) => typeof name === "string" && (extra.has(name) || NAMED_RESIDENT.has(name));
}

export default { createResident, nameOnlyResident, NAMED_RESIDENT };
