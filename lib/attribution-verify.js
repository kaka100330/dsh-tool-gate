/**
 * Declare-then-verify for tool ownership.
 *
 * `owner.js` recovers ownership from the environment: the context a registration
 * arrived on, the call stack, a static table, an on-disk scan. Each source is a
 * *guess with a confidence*, and one of them is systematically wrong — the context
 * channel answers "whose context was this registration made on", which for a
 * plugin that registers *into an agent scope* is the host, not the registrant.
 * That single case put all 18 `ops_*` tools in a family called "Agent Loop".
 *
 * This module turns that failure into a checkable state. It is a **pure function**:
 * entries in, repairs and diagnostics out, no IO and no clock, so every rule can
 * be tested offline. The evidence (which package declares which tool name, which
 * name prefixes a package claims) is read from disk by the caller and injected.
 *
 * Nothing here invents an owner. A repair needs positive evidence naming another
 * package; without it the entry is downgraded to `unknown`, which downstream means
 * "stay on the wire" — the failure direction that costs tokens rather than tools.
 */

import { engineReason, isEnginePackage } from "./engine-packages.js";

/** Where an ownership answer came from, most authoritative first. */
export const SOURCES = Object.freeze({
  /** The package's own source spells the name out (`name: "x"`, `name: PREFIX + "x"`). */
  DECLARED: "declared",
  /** A Loader entry context tagged the registration (exact for the common shape). */
  CONTEXT: "context-chain",
  /** The call stack walked up to the registrant's `package.json`. */
  STACK: "stack",
  /** The checked-in snapshot of a past profile. Stale by construction. */
  STATIC: "static-table",
  /** Nothing could place it. */
  UNKNOWN: "unknown",
});

/** Confidence per source. Only `high` may found a family after a repair. */
const CONFIDENCE = {
  [SOURCES.DECLARED]: "high",
  [SOURCES.CONTEXT]: "medium",
  [SOURCES.STACK]: "medium",
  [SOURCES.STATIC]: "low",
  [SOURCES.UNKNOWN]: "unknown",
};

/** Build one identity record with the confidence its source implies. */
export function makeIdentity(input) {
  const pkg = typeof input?.pkg === "string" && input.pkg !== "" ? input.pkg : undefined;
  const source = Object.values(SOURCES).includes(input?.source) ? input.source : SOURCES.UNKNOWN;
  return {
    pkg,
    /** The Loader specifier, kept for diagnostics only; never used for identity. */
    specifier: typeof input?.specifier === "string" && input.specifier !== "" ? input.specifier : undefined,
    source,
    confidence: CONFIDENCE[source] ?? "unknown",
    evidence: typeof input?.evidence === "string" ? input.evidence : undefined,
  };
}

/** Find the package that claims a name prefix covering `name`, if any. */
function prefixClaim(name, prefixes, exclude) {
  if (prefixes === undefined) return undefined;
  let best;
  for (const [pkg, claimed] of prefixes) {
    if (pkg === exclude) continue;
    if (isEnginePackage(pkg)) continue;
    for (const prefix of claimed) {
      if (prefix === "" || !name.startsWith(prefix)) continue;
      // The most specific claim wins: `blender_rt_` beats `blender_`.
      if (best === undefined || prefix.length > best.prefix.length) best = { pkg, prefix };
    }
  }
  return best;
}

/**
 * Check every ownership entry against the installed packages' own declarations.
 *
 * @param options.entries - `[{ name, identity }]`, identity as produced by
 *   {@link makeIdentity} (or by `owner.js`).
 * @param options.evidence - `{ declared: Map<name, pkg>, prefixes: Map<pkg, prefix[]> }`,
 *   as returned by `tool-scan.js` `scanEvidence()`. Omitted means "no evidence":
 *   the verifier then only downgrades engine ownership, never repairs.
 * @param options.isEngine - optional override of {@link isEnginePackage}, for tests.
 * @returns `{ repairs, downgrades, conflicts, diagnostics }`:
 *  - `repairs`    name -> identity (a *different* package, with high confidence),
 *  - `downgrades` names whose owner is machinery and could not be re-placed,
 *  - `conflicts`  names whose two best evidence sources disagree,
 *  - `diagnostics` one line per finding, for `describe().diagnostics`.
 */
export function verifyAttribution(options) {
  const entries = Array.isArray(options?.entries) ? options.entries : [];
  const evidence = options?.evidence;
  const declared = evidence?.declared;
  const prefixes = evidence?.prefixes;
  const isEngine = typeof options?.isEngine === "function" ? options.isEngine : isEnginePackage;

  const repairs = new Map();
  const downgrades = new Set();
  const conflicts = [];
  const diagnostics = [];

  const note = (severity, code, text, names) =>
    diagnostics.push({ severity, code, text, tools: names ?? [], source: "attribution" });

  for (const entry of entries) {
    const name = entry?.name;
    const identity = entry?.identity;
    if (typeof name !== "string" || name === "" || identity === undefined) continue;
    const pkg = identity.pkg;
    if (typeof pkg !== "string" || pkg === "") continue;
    const engine = isEngine(pkg);
    const claimedBy = declared?.get?.(name);

    // R-b: engine counter-evidence. The registry says the host; a package's own
    // source says its own name. The source wins: the host cannot register a tool
    // it does not define, and this is exactly the `ops_*` case.
    if (engine && typeof claimedBy === "string" && claimedBy !== pkg && !isEngine(claimedBy)) {
      repairs.set(name, makeIdentity({
        pkg: claimedBy,
        specifier: identity.specifier,
        source: SOURCES.DECLARED,
        evidence: `${claimedBy} 的源码声明了 ${name}`,
      }));
      continue;
    }

    // R-b2: nobody could place it, but a package's own source does. The registry
    // answered "unknown" (a tool that registered before this plugin mounted, or a
    // snapshot entry that named machinery), so there is nothing to contradict —
    // the declaration is simply better information than no information.
    if (
      (identity.confidence === "unknown" || identity.confidence === "low") &&
      typeof claimedBy === "string" &&
      claimedBy !== pkg &&
      !isEngine(claimedBy)
    ) {
      repairs.set(name, makeIdentity({
        pkg: claimedBy,
        specifier: identity.specifier,
        source: SOURCES.DECLARED,
        evidence: `${claimedBy} 的源码声明了 ${name}`,
      }));
      continue;
    }

    // R-a: prefix claim. `dsh-ops` declares `TOOL_PREFIX = "ops_"` and builds every
    // name as prefix + capability, so no literal declaration exists to find.
    if (engine || identity.confidence === "low" || identity.confidence === "unknown") {
      const claim = prefixClaim(name, prefixes, pkg);
      if (claim !== undefined) {
        repairs.set(name, makeIdentity({
          pkg: claim.pkg,
          specifier: identity.specifier,
          source: SOURCES.DECLARED,
          evidence: `${claim.pkg} 声明了工具名前缀 "${claim.prefix}"`,
        }));
        continue;
      }
    }

    // Downgrade: machinery that could not be re-placed owns nothing. Downstream
    // this means "unknown", and unknown means exposed — never a family named
    // after the engine.
    if (engine) {
      downgrades.add(name);
      note("warn", "D6", `工具 ${name} 的归属落在引擎包 ${pkg}（${engineReason(pkg)}），已降级为未知，保持常驻。`, [name]);
      continue;
    }

    // R-c: contradictory evidence. Not repaired (the live answer is at least as
    // good as the scan here) but visible, because a package whose tools split
    // between two owners is how the `ops_*` split was found in the first place.
    if (typeof claimedBy === "string" && claimedBy !== pkg && !isEngine(claimedBy)) {
      conflicts.push({ name, owner: pkg, claimedBy });
      note("warn", "D2", `工具 ${name} 记在 ${pkg}，但 ${claimedBy} 的源码也声明了它。`, [name]);
    }
  }

  // A package whose tools are split between itself and machinery is the
  // half-collapsed shape; `downgrades` names the tools that stayed unplaced, so a
  // caller can report the split per package instead of per tool.
  return { repairs, downgrades, conflicts, diagnostics };
}

export default { verifyAttribution, makeIdentity, SOURCES };
