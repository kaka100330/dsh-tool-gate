/**
 * Degenerate-family suppression — the rule that stops a gateway from costing more
 * than it saves.
 *
 * A family is worth a gateway only when the tools behind it cost more than the
 * gateway does. That sentence was missing, and its absence is what produced a
 * `subagent2` gateway: three members, two of them resident forever, so the gateway
 * schema (three parameters plus a description) was priced against a single ~200
 * token tool. It saved nothing and cost a tool the model had to learn.
 *
 * The rule, from the analysis document §3.4(c):
 *
 * ```
 * collectable      = members.filter(m => !isResident(m))
 * saving           = Σ tokens(collectable)
 * gateway cost     = FIXED_OVERHEAD + tokens(description)
 * worth a family   = collectable ≥ 1  &&  saving > k × gateway cost
 * ```
 *
 * `k` is `degenerateThreshold` (default **3**, per the user's decision: a family
 * must save three times its own price to be worth the indirection). Raising it
 * keeps more tools resident; `families.<id>.force: true` overrides it for one
 * family the user wants collapsed anyway.
 *
 * Why compare against the *cost*, not just "saving > 0": a gateway is not free
 * even when it is profitable. It adds a name the model must recognise, a wrong
 * call the model can make (`action`/`tool`/`arguments` instead of the tool's own
 * parameters), and one hop of dispatch. Three-to-one is the point where that is
 * clearly worth paying.
 *
 * Nothing here reads the disk, the registry or the config: it is a pure function
 * of members, their sizes and the residency predicate, so the same inputs always
 * produce the same verdict, and the verdict can be unit-tested without a host.
 */

/**
 * Token cost of a gateway that carries no description at all.
 *
 * Covers the schema shell, the name, and the three parameters every gateway
 * declares (`action`, `tool`, `arguments`). Measured against a real gateway
 * schema, rounded up. Kept as a constant rather than derived per call because it
 * is the *floor* the comparison needs, and a per-family derivation would make two
 * families with equally sized gateways disagree.
 */
export const FIXED_OVERHEAD = 60;

/** Default `k`: saving must exceed this multiple of the gateway's own cost. */
export const DEFAULT_THRESHOLD = 3;

/** Token estimate for one JSON-serialisable value (bytes / 3.2, as the profile does). */
export function estimateTokens(value) {
  try {
    return Math.round(Buffer.byteLength(JSON.stringify(value) ?? "", "utf8") / 3.2);
  } catch {
    return 0;
  }
}

/**
 * What one gateway costs to put on the wire.
 *
 * @param description - the family description, which is most of a gateway schema's
 *   bytes in practice; empty for a family the host could not describe.
 * @returns tokens, never below `FIXED_OVERHEAD`.
 */
export function gatewayCost(description) {
  return FIXED_OVERHEAD + estimateTokens(typeof description === "string" ? description : "");
}

/** Why a family is, or is not, worth a gateway. */
export const REASONS = Object.freeze({
  /** No members at all: nothing behind the gateway. */
  EMPTY: "no-members",
  /** Members exist, all resident: collapsing would hide nothing. */
  ALL_RESIDENT: "no-collectable-members",
  /** Something to hide, but not enough to pay for the gateway. */
  BELOW: "below-threshold",
  /** Worth a gateway. */
  WORTH: "collectable",
  /** The user's `force: true` overrode the threshold. */
  FORCED: "forced",
});

/**
 * Assess one family against the suppression rule.
 *
 * @param family - the family record (`id`, `label`, `description`, `enabled`, `force`).
 * @param members - its live member schemas.
 * @param isResident - the single residency predicate from `resident.js`.
 * @param threshold - `k`; defaults to `DEFAULT_THRESHOLD`.
 * @param tokensOf - optional `(schema) => number`, a token estimate with a cache
 *   in front of it (the caller usually has one; `estimateTokens` is the fallback).
 * @returns the assessment, including the numbers behind the verdict so a
 *   diagnostic can print "saves 240, costs 120, needs 360".
 */
export function assessFamily({ family, members, isResident, threshold, tokensOf }) {
  const rows = Array.isArray(members) ? members : [];
  const k = Number.isFinite(threshold) && threshold >= 0 ? threshold : DEFAULT_THRESHOLD;
  const size = typeof tokensOf === "function" ? tokensOf : estimateTokens;
  let residentCount = 0;
  let collectableCount = 0;
  let tokens = 0;
  let collectableTokens = 0;
  for (const schema of rows) {
    const weight = size(schema);
    tokens += weight;
    const name = schema?.name;
    const resident = typeof name === "string" && isResident(name);
    if (resident) {
      residentCount += 1;
    } else {
      collectableCount += 1;
      collectableTokens += weight;
    }
  }
  const cost = gatewayCost(family?.description ?? "");
  const saving = collectableTokens - cost;
  const forced = family?.force === true;
  let reason;
  let worth;
  if (rows.length === 0) {
    reason = REASONS.EMPTY;
    worth = false;
  } else if (collectableCount === 0) {
    reason = REASONS.ALL_RESIDENT;
    worth = false;
  } else if (forced) {
    reason = REASONS.FORCED;
    worth = true;
  } else if (collectableTokens > k * cost) {
    reason = REASONS.WORTH;
    worth = true;
  } else {
    reason = REASONS.BELOW;
    worth = false;
  }
  return {
    id: family?.id,
    count: rows.length,
    residentCount,
    collectableCount,
    tokens,
    collectableTokens,
    /** Gateway cost in tokens (`FIXED_OVERHEAD` + description). */
    cost,
    /** What the gateway would actually save: collectable tokens minus its cost. */
    saving,
    threshold: k,
    /** `saving / cost`, for a diagnostic that wants to say "1.2×, needs 3×". */
    ratio: cost === 0 ? 0 : Number((saving / cost).toFixed(2)),
    worth,
    forced,
    reason,
    /** Diagnostics: members that stay on the wire while their siblings collapse. */
    halfCollapsed: residentCount > 0 && collectableCount > 0,
  };
}

/**
 * Assess every family in one pass.
 *
 * @param families - resolved family table.
 * @param membersOf - `(familyId) => schema[]`; the caller's registry read.
 * @param isResident - the residency predicate.
 * @param threshold - `k`.
 * @param tokensOf - optional cached token estimate.
 * @returns `Map<familyId, assessment>`.
 */
export function assessFamilies({ families, membersOf, isResident, threshold, tokensOf }) {
  const out = new Map();
  for (const family of Object.values(families ?? {})) {
    const members = typeof membersOf === "function" ? membersOf(family.id) ?? [] : [];
    out.set(family.id, assessFamily({ family, members, isResident, threshold, tokensOf }));
  }
  return out;
}

/**
 * Family ids that may be collapsed: enabled, and worth a gateway.
 *
 * @returns a `Set` of ids, or `undefined` when the assessments are unavailable —
 *   and `undefined` must mean "suppress nothing", never "suppress everything": an
 *   unreadable registry must not withdraw every gateway in the session.
 */
export function collapsibleIds(families, assessments) {
  if (assessments === undefined || assessments === null) return undefined;
  const out = new Set();
  for (const [id, assessment] of assessments) {
    const family = families?.[id];
    if (family === undefined || family.enabled === false) continue;
    if (assessment.worth === true) out.add(id);
  }
  return out;
}
