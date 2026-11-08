/**
 * dsh-tool-gate — progressive disclosure for DSH tools.
 *
 * The goal is narrow and measurable: keep the wire `tools` array **byte-identical**
 * across turns while letting third-party families of tools live behind a handful
 * of stable gateway tools. Every held-out tool definition is prefix the provider
 * would otherwise re-read (and, with prompt caching, re-pay for on every turn that
 * changes anything else in the prefix).
 *
 * Where a tool can be hidden depends on the host version, and this file speaks
 * both contracts:
 *
 *  - **DSH <= 0.2.1** put the assembled `tools` array in the
 *    `system-prompt/assemble` waterfall payload and honoured a listener that
 *    replaced it, so the frozen surface is returned from this hook.
 *  - **DSH >= 0.2.2** made tool declarations provider-owned: the payload carries
 *    sections/contexts/variables only and the host re-attaches its own list
 *    afterwards, so replacing `tools` here is discarded. The surface is enforced
 *    instead at the per-scope tool executor (`presentation.js`), which is what
 *    the host asks for the provider result.
 *
 * Two facts hold on both:
 *
 *  1. Execution does not consult the wire: `dispatchToolBody` resolves the
 *     definition from the registry, so a collapsed tool still runs — through its
 *     gateway, and (by design) not directly.
 *  2. The request header only changes when the assembled tool bytes change, so a
 *     frozen surface stops the prefix from being re-written.
 *
 * Nothing here mutates the registry — gateways aside, which are ordinary tools.
 * Disabling the plugin restores every tool on the next assembly, with no restart.
 */

import { appendPluginRecord, pluginRecordOf } from "@deepseek-ai/dsh-session";

import { Config } from "./config.js";
import {
  buildFrozenSurface,
  createFamilyResolver,
  gatewayName,
  resolveFamilies,
  residentNames,
} from "./families.js";
import { reconcileGateways } from "./gateways.js";
import { createExecutorFilter } from "./presentation.js";
import { registerBridge } from "./bridge.js";
import { installInterception } from "./guard.js";
import { createMetaReader } from "./plugin-meta.js";
import { createOwnerIndex, SELF_PACKAGE_NAME, UNKNOWN } from "./owner.js";
import { createResident, nameOnlyResident } from "./resident.js";
import {
  DEFAULT_THRESHOLD,
  assessFamily,
  collapsibleIds,
  estimateTokens,
} from "./degenerate.js";
import { diagnose } from "./diagnostics.js";
import { migratePromptPlugins } from "./migrate.js";
import { isHarnessPackage, barePackageName } from "./ownership-channel.js";
import { createPromptDisclosure } from "./prompt-scan.js";
import { forgetScanCache } from "./tool-scan.js";
import {
  agentRowOf,
  configureSessionApi,
  createStateStore,
  readGateRecord,
  writeGateRecord,
} from "./state.js";

export { Config };

/** Plugin name, also this bundle's settings-page entry id. */
export const name = "dsh-tool-gate";

/**
 * `tools` is required (gateways are tools). `systemPrompt` is required for the
 * assemble hook. Nothing else is declared: a hard `inject` prefix means a missing
 * service stalls the plugin forever, and every other need here has a fallback.
 */
export const inject = ["tools", "systemPrompt"];

/** Section name for the static notice; stable so a re-entry can dedupe it. */
const NOTICE_SECTION = "tool-gate: progressive-disclosure";

/** The single tool the host leaves in a collapsed (PTC) scope. */
const RUN_CODE = "run_code";

/**
 * Unwrap the live `Volatile<T>` references the Loader hands `apply`.
 *
 * Volatile fields arrive as `{ get() }` so the plugin sees profile edits without a
 * remount; reading them fresh on every decision keeps that promise.
 */
function readConfig(config) {
  if (config === null || typeof config !== "object") return {};
  const out = {};
  for (const [key, value] of Object.entries(config)) {
    out[key] = value !== null && typeof value === "object" && typeof value.get === "function" ? value.get() : value;
  }
  return out;
}

/**
 * The static notice, built once per agent.
 *
 * Rules first (what a gateway *is*, said once), then the roster (which families
 * are collapsed this session). The rules used to be repeated on every gateway's
 * own description — 351 bytes × one per gateway, 85% of all gateway description
 * text — because each gateway was written to be readable on its own. One notice
 * makes that unnecessary.
 *
 * The roster carries both the gateway name and the label. The name is the anchor
 * the model matches against the tool list; the label is what says what the
 * gateway is for. Only the names would save another 128 bytes and leave the
 * labels unreachable from the prompt, which is where the model actually decides.
 *
 * It is cached on the agent state on purpose: the notice is prompt-prefix text, so
 * it has to be byte-identical on every turn. Only the collapsed set and the family
 * table may be read here — nothing that moves per turn — for the same reason.
 */
function buildNotice(collapsed, familyOf, families, gatewayNameFor) {
  const ids = new Set();
  for (const name of collapsed) {
    const family = familyOf(name);
    if (family !== undefined) ids.add(family);
  }
  if (ids.size === 0) return undefined;
  const roster = [...ids]
    .sort()
    .map((id) => {
      const label = families[id]?.label || id;
      return `\`${gatewayNameFor(id)}\` ${label}`;
    })
    .join(" · ");
  return [
    "## 工具网关（渐进披露）",
    "",
    "本轮工具列表里带 `action` / `tool` / `arguments` 三个参数的网关工具，各代表一个插件家族："
      + "家族的全部成员工具已从本轮工具列表移出，按需取用。",
    "",
    "- `action: \"list\"`：返回该家族全部成员的名字、说明与完整参数定义；同一家族第二次 `list` 只回一行提示，定义已在历史里。",
    "- `action: \"call\"` 配 `tool` 与 `arguments`：按成员定义调用，返回值与直接调用一致。",
    "",
    "直接调用已收起成员的名字会被拦截并提示改走网关——那不是成员工具本身的问题。",
    "",
    `本轮收起：${roster}`,
  ].join("\n");
}

/**
 * Plugin entry.
 *
 * @param ctx - the plugin's context.
 * @param config - live (volatile) configuration.
 */
export function apply(ctx, config) {
  const logger = ctx.logger;

  // The session package's plugin-record helpers, installed once for `state.js`.
  try {
    configureSessionApi({ appendPluginRecord, pluginRecordOf });
  } catch (error) {
    logger?.debug?.(`dsh-tool-gate: plugin records unavailable (${String(error?.message ?? error)})`);
  }

  /** Live config reader — every decision goes through this, never a cached copy. */
  const currentConfig = () => readConfig(config);

  /**
   * Gateway tool names, before the family table exists.
   *
   * The owner index needs to know them up front — see `unscannable` below — but
   * they are derived from the family table, which is derived from the owner
   * index. The loop is broken by keeping the set live: `reconcileGateways` fills
   * it, and `registered()` reads it by reference on every call.
   */
  const unscannable = new Set();

  const ownerIndex = createOwnerIndex(ctx, logger, {
    // Gateway names are ours: no bundle's source names them, so offering them to
    // the on-disk scan can only ever produce a full re-read and no answer.
    unscannable,
    // Read live: `diskScan` is a volatile config field, and flipping it must take
    // effect on the next turn rather than at the next remount.
    diskScan: () => currentConfig().diskScan !== "off",
    // Read live for the same reason, and because the verifier is the difference
    // between "the engine package owns these tools" (the bug) and "the plugin that
    // declared them owns them". Off means trusting attribution as reported.
    verify: () => currentConfig().verifyAttribution !== false,
  });

  /**
   * The single residency predicate — one answer, four consumers.
   *
   * Family discovery (does this package define a family?), the frozen surface
   * (may this name be hidden?), the family cards (how many members are hidden?)
   * and the degenerate check (can this family save anything?) all ask this, and
   * nothing else. They used to each keep their own opinion: discovery dropped
   * resident names, the card counted them, `keep-tools.js` hand-listed seven
   * `ops_*` names out of eighteen — and the two halves of the `ops_*` set ended up
   * behind different calling conventions.
   *
   * The layers, in order: the user's own pins, the name layer (`keep-tools.js`),
   * engine packages, `ops_`-prefixed tools owned by `dsh-ops`, and context
   * packages (`billion-context`, …).
   */
  /**
   * Build the predicate once per pin set — `isResident` is called for every tool
   * name on every assembly, and rebuilding a closure (plus a Set of the pins) that
   * often is pure waste.
   */
  let residentCache = { key: undefined, predicate: nameOnlyResident([]) };
  const residentPredicate = () => {
    const pins = currentConfig().residentTools ?? [];
    const key = Array.isArray(pins) ? pins.join("\u0000") : "";
    if (residentCache.key !== key) {
      residentCache = {
        key,
        predicate: createResident({ ownerOf: ownerIndex.ownerOf, pins: Array.isArray(pins) ? pins : [] }),
      };
    }
    return residentCache.predicate;
  };
  const isResident = (name) => residentPredicate()(name);
  const states = createStateStore();

  /**
   * Gateway descriptions and labels, read from the host rather than from a table
   * in this package: the same `pluginPackages` service the settings page uses, so
   * an installed plugin describes itself here without an edit in this repository.
   */
  const metaReader = createMetaReader({
    ctx,
    logger,
    // Read live: the ceiling is a config field the user may change at any time,
    // and a stale copy would keep truncating after they set it to 0.
    maxChars: () => currentConfig().maxDescriptionChars ?? 0,
  });

  const gatewayNameFor = (familyId) =>
    gatewayName(currentConfig().gatewayPrefix, familyId, families[familyId]?.gateway);
  const labelFor = (familyId) => families[familyId]?.label || familyId;

  /**
   * Iterate the *names* out of a `view()` field that may be a Set or a Map.
   *
   * The host answers `view(scope).visible` with a `Map<name, definition>`
   * (both 0.2.1 and 0.2.2), while `knownNames`/`restrictableNames` are `Set`s.
   * `for (const x of map)` yields `[key, value]` pairs, which silently poisons
   * every downstream `familyOf(name)` lookup: the "name" is an array, so
   * attribution answers "unknown", every family looks empty, and no gateway is
   * ever registered. Reading `.keys()` is the whole fix.
   *
   * @param field - a `Set`, a `Map`, or an array of names.
   * @returns an iterable of names.
   */
  const namesOf = (field) => {
    if (field === undefined || field === null) return [];
    // Arrays also expose `.keys()` — it yields indices, not names — so the
    // container is tested before the method.
    if (Array.isArray(field)) return field;
    return typeof field.keys === "function" ? field.keys() : field;
  };

  /**
   * Every tool name the registry can serve, in any scope.
   *
   * Family discovery needs this because ownership alone is not enough: a tool
   * registered before this plugin mounted and *outside the global layer* has no
   * live attribution, and `dsh-tool-schedule` registers exactly that way. Asking
   * the registry which names exist lets the static attribution table fill in the
   * owners it knows without inventing families for plugins that are not installed.
   *
   * `view()` rather than `schemas()`: both derive the same name set, but
   * `schemas()` deep-clones every tool's parameter schema on the way out
   * (`dsh-tools` `schemaOf(definition, true)`), which measured 0.2 ms per tool
   * and ran on every assembly, for every agent, twice. `view()` builds the maps
   * and no clones.
   */
  const knownNames = () => {
    const names = new Set();
    const collect = (scope) => {
      try {
        const view = ctx.tools?.view?.(scope);
        if (view?.knownNames !== undefined) {
          for (const name of view.knownNames) names.add(name);
          return;
        }
        // Fallback for a host without `view()`: the old projection.
        for (const schema of ctx.tools.schemas(scope) ?? []) {
          if (typeof schema?.name === "string") names.add(schema.name);
        }
      } catch {
        /* scope not resolvable; skip */
      }
    };
    collect(undefined);
    try {
      for (const agent of ctx.get("agents")?.list?.() ?? []) collect(agent);
    } catch {
      /* agents service not reachable yet */
    }
    return names;
  };

  /**
   * Every tool name that is *actually callable* in some scope.
   *
   * This is deliberately narrower than `knownNames()`. `knownNames()` answers
   * "the registry has heard of this name", which includes two kinds of entry the
   * model can never call:
   *
   *  - names known only through a **scope-less** read: a tool a bundle registers
   *    inside `ctx.inject` lives in the agent layer, so a scope-less `view()`
   *    returns the *unrestricted* superset of every layer — including tools the
   *    calling agent has had restricted away. `dsh-ops` restricts exactly this
   *    way (`NATIVE_REPLACEMENTS = ["read", "glob", "grep"]` arrives as
   *    `agent.restrict({ deny })`);
   *  - anything absent from every agent's `visible` set.
   *
   * That distinction is what put an empty gateway on the wire. `fs_search` was
   * judged non-empty from the scope-less `knownNames()` view while its members
   * were all restricted out of the scopes that existed, so a gateway was
   * registered whose `list` could only ever answer "no members". The page, which
   * counts through `schemas(agent)`, correctly showed zero members — hence a
   * gateway visible to the model and a row hidden from the user.
   *
   * The set is the union of every agent's `view(scope).visible`, plus the scope
   * currently being assembled, so a populated family in *any* live scope keeps its
   * gateway. Only a host with no agent scopes at all falls back to the scope-less
   * view, where there is nothing to restrict and the old answer is the right one.
   *
   * @param primaryScope - the agent whose assembly is in flight, if any.
   */
  const callableNames = (primaryScope) => {
    const names = new Set();
    let sawScope = false;
    const collect = (scope) => {
      if (scope === undefined || scope === null) return;
      sawScope = true;
      try {
        const view = typeof ctx.tools?.view === "function" ? ctx.tools.view(scope) : undefined;
        if (view?.visible !== undefined) {
          for (const name of namesOf(view.visible)) names.add(name);
          return;
        }
        // A host without `view()` — the old projection, restricted the same way.
        for (const schema of ctx.tools?.schemas?.(scope) ?? []) {
          if (typeof schema?.name === "string") names.add(schema.name);
        }
      } catch {
        /* this scope is not resolvable right now; others still count */
      }
    };
    collect(primaryScope);
    let agents = [];
    try {
      agents = [...(ctx.get("agents")?.list?.() ?? [])];
    } catch {
      agents = [];
    }
    for (const agent of agents) collect(agent);
    if (sawScope) return names;
    // No scopes anywhere: the scope-less view is all there is.
    try {
      const view = typeof ctx.tools?.view === "function" ? ctx.tools.view(undefined) : undefined;
      if (view?.visible !== undefined) {
        for (const name of namesOf(view.visible)) names.add(name);
      } else {
        for (const schema of ctx.tools?.schemas?.() ?? []) {
          if (typeof schema?.name === "string") names.add(schema.name);
        }
      }
    } catch {
      /* nothing readable; callers treat an empty answer as "unknown", not "empty" */
    }
    return names;
  };

  /**
   * Resolve the family table from the live registry.
   *
   * Discovery reads the owner snapshot, so the answer changes when a plugin is
   * installed, removed, or enabled — not only when the config changes. The
   * signature covers both inputs, and the derived table is cheap enough (one pass
   * over a few hundred names) to rebuild whenever either moves.
   */
  /**
   * Report sink for family resolution — aliases taken, config keys that matched
   * nothing, packages that could not be given a clean name.
   *
   * Filled in place on every rebuild and read by `describe().diagnostics`, which
   * is why it is one object mutated rather than a returned value: `resolveFamilies`
   * already returns the family table, and every existing caller destructures that.
   */
  const familyReport = { aliasUses: [], orphanKeys: [], rejected: [] };
  const resetReport = () => {
    familyReport.aliasUses.length = 0;
    familyReport.orphanKeys.length = 0;
    familyReport.rejected.length = 0;
  };

  const resolveNow = (live, owners) => {
    const snapshot = owners ?? ownerIndex.registered(knownNames());
    resetReport();
    return resolveFamilies(live.families, {
      builtinEnabled: live.builtinFamilies !== false,
      auto: live.autoFamilies !== false,
      owners: snapshot,
      selfPackage: SELF_PACKAGE_NAME,
      residentTools: live.residentTools ?? [],
      // The single residency predicate, so discovery cannot disagree with the
      // frozen surface about what is already on the wire.
      isResident,
      // A family id may not shadow any registered tool, not just a resident one:
      // the gateway is a tool, and the harness throws on a duplicate name. The old
      // code resolved such a collision by appending `2`, which is how a gateway
      // became `subagent2` and the config key became `families.subagent2`.
      reservedIds: Object.keys(snapshot),
      specifiers: ownerIndex.specifiers?.(),
      report: familyReport,
      // Only consulted when no label/description hint applies; the host answers
      // for every plugin it can see, so a new plugin needs no edit here.
      metadata: (pkg) => metaReader.describe(pkg),
    });
  };

  /**
   * Signature inputs: the override dict, the switches, and the live registry.
   *
   * Computed from the same owner snapshot `resolveNow` will use, so one
   * `registered()` call serves both — it is memoized, but asking twice for the
   * same answer and then throwing one away is still a wasted sort of ~100 names
   * on every tool call.
   */
  const signatureOf = (live, owners) =>
    JSON.stringify([
      live.families ?? {},
      live.builtinFamilies !== false,
      live.autoFamilies !== false,
      live.residentTools ?? [],
      owners ?? ownerIndex.registered(knownNames()),
    ]);

  const initialOwners = ownerIndex.registered(knownNames());
  let families = resolveNow(currentConfig(), initialOwners);
  let resolver = createFamilyResolver(families, ownerIndex.ownerOf, gatewayNameFor);
  let familySignature = signatureOf(currentConfig(), initialOwners);

  /**
   * Fold pre-merge per-package prompt switches onto their families.
   *
   * Runs here — after the family table exists, because the map from package to
   * family is what makes the rewrite possible. Idempotent, so running it on every
   * mount is fine; afterwards only the family flag is read, which is what keeps a
   * single switch in the page from having two sources of truth.
   */
  const migration = migratePromptPlugins({ config, families, logger });
  if (migration.migrated) {
    families = resolveNow(currentConfig(), initialOwners);
    resolver = createFamilyResolver(families, ownerIndex.ownerOf, gatewayNameFor);
    familySignature = signatureOf(currentConfig(), initialOwners);
  }

  /**
   * Keep the family table in step with live config and registry edits.
   *
   * @param options.force - rebuild even when the signature looks unchanged. Used
   *   by `POST /refresh`, where the caller has just dropped the scan and owner
   *   caches and wants the answer re-derived rather than compared.
   */
  const refreshFamilies = (options) => {
    const live = currentConfig();
    const owners = ownerIndex.registered(knownNames());
    const signature = signatureOf(live, owners);
    if (options?.force === true || signature !== familySignature) {
      familySignature = signature;
      families = resolveNow(live, owners);
      resolver = createFamilyResolver(families, ownerIndex.ownerOf, gatewayNameFor);
    }
    return live;
  };

  /** One registered tool's definition, read through the provider's own view. */
  const definitionOf = (name, agent) => {
    try {
      const view = typeof ctx.tools?.view === "function" ? ctx.tools.view(agent) : undefined;
      const visible = view?.visible;
      if (visible instanceof Map) return visible.get(name);
      if (Array.isArray(visible)) return visible.find((definition) => definition?.name === name);
      return undefined;
    } catch {
      return undefined;
    }
  };

  /**
   * Token weight of one tool schema, memoized by name.
   *
   * `JSON.stringify` per schema per round would dominate the collapse decision: the
   * plan runs for every round of every agent, and the answer only changes when a
   * tool is re-registered — which is exactly when the cache is dropped
   * (`reconcileNow`, `refreshInventory`). Live schemas are still read fresh; only
   * the *size* is remembered.
   */
  const tokenWeights = new Map();
  const tokensOfSchema = (schema) => {
    const name = schema?.name;
    if (typeof name !== "string" || name === "") return estimateTokens(schema);
    const cached = tokenWeights.get(name);
    if (cached !== undefined) return cached;
    const weight = estimateTokens(schema);
    tokenWeights.set(name, weight);
    return weight;
  };

  /**
   * Assess every family against the degenerate rule (`degenerate.js`).
   *
   * Grouping is one pass over the schemas the caller already has and the weights
   * are memoized, so this is cheap enough to run per round — which it must be,
   * because "is this family worth a gateway?" is what decides whether its members
   * may be hidden at all. A family that cannot pay for its gateway keeps every
   * member on the wire, and its gateway is never mounted (see `withheldFamilyIds`).
   */
  const assessmentsOf = (schemas) => {
    const byFamily = new Map();
    for (const schema of schemas ?? []) {
      const name = schema?.name;
      if (typeof name !== "string" || name === "") continue;
      const familyId = resolver.familyOf(name);
      if (familyId === undefined) continue;
      let list = byFamily.get(familyId);
      if (list === undefined) byFamily.set(familyId, (list = []));
      list.push(schema);
    }
    const threshold = currentConfig().degenerateThreshold ?? DEFAULT_THRESHOLD;
    const out = new Map();
    for (const family of Object.values(families)) {
      out.set(family.id, assessFamily({
        family,
        members: byFamily.get(family.id) ?? [],
        isResident,
        threshold,
        tokensOf: tokensOfSchema,
      }));
    }
    return out;
  };

  /**
   * Family ids that may actually be collapsed for this set of schemas, or
   * `undefined` when the set is unavailable — and `undefined` must suppress
   * nothing rather than everything.
   */
  const collapsibleSetOf = (schemas) => collapsibleIds(families, assessmentsOf(schemas));

  /**
   * Decide the wire surface *for the round that is being built right now*.
   *
   * This runs from inside the provider (`describe(tools)`, see `presentation.js`),
   * and that placement is the whole point: `tools` is the exact definition list
   * the host is about to turn into the request. Deciding here means the surfacing
   * lands in this round instead of the next one. The assemble waterfall cannot do
   * that on 0.2.2 — the provider has already collected its list by the time it
   * runs, so a decision taken there is always one round late, and a session's
   * first round would ship every tool this plugin exists to hide.
   *
   * One rule keeps it safe: a member is only hidden when its family's gateway is
   * on this very wire. Hiding a member whose gateway is missing would leave a tool
   * that nothing can reach — worse than paying its tokens for one round.
   *
   * @param tools - definitions handed to `describe()`.
   * @param agent - the scope being assembled.
   * @returns the names to withhold from this round, or `{ hidden, extra }` when
   *   a gateway had to be mounted for this same round (see `extra` below).
   */

  const planProviderSurface = (tools, agent) => {
    const hidden = new Set();
    // Read the family table *now*. `ownerIndex` records an owner after the host's
    // `register()` returns, so the `tools/change` reconcile can run one step
    // before the attribution for that very tool exists; a family derived then is
    // stale, and its members would stay uncollapsed for the whole session. This
    // call is a signature comparison when nothing moved, so it is cheap.
    const live = refreshFamilies();
    if (live.enabled !== true) return hidden;

    const definitions = Array.isArray(tools) ? tools : [];
    const present = new Set();
    for (const definition of definitions) {
      if (typeof definition?.name === "string") present.add(definition.name);
    }
    if (present.size === 0) return hidden;

    const state = states.ensure(agent);

    // A collapsed (PTC) scope receives `run_code` and nothing else: there is
    // nothing to fold there, and the transport must stay reachable.
    if (present.size === 1 && present.has(RUN_CODE)) {
      state.ptc = true;
      return hidden;
    }

    const built = buildFrozenSurface(definitions, {
      familyOf: resolver.familyOf,
      families,
      alwaysExpose: live.alwaysExpose ?? [],
      alwaysHide: live.alwaysHide ?? [],
      unknownOwnerPolicy: live.unknownOwnerPolicy === "collapse" ? "collapse" : "expose",
      keepNames: new Set(gatewayNames),
      residentTools: live.residentTools ?? [],
      isResident,
      collapsibleFamilies: collapsibleSetOf(definitions),
    });

    // Families whose members want withholding but whose gateway is not on this
    // list yet. That is the first round after the gate is switched on, or the
    // first round that sees a family: the provider collected its definitions
    // before the reconcile below could register anything.
    const missing = new Set();
    for (const name of built.collapsed) {
      const familyId = resolver.familyOf(name);
      if (familyId === undefined) continue;
      if (!present.has(gatewayNameFor(familyId))) missing.add(familyId);
    }
    const extra = [];
    if (missing.size > 0) {
      // Register now rather than at the next hook: a gateway that only appears
      // in the *next* round leaves its members on the wire for this one, and a
      // session pays that cost in its first request.
      reconcileNow(agent);
      for (const familyId of missing) {
        const gateway = gatewayNameFor(familyId);
        if (present.has(gateway)) continue;
        const definition = definitionOf(gateway, agent);
        if (definition === undefined) continue;
        present.add(gateway);
        extra.push(definition);
      }
    }

    for (const name of built.collapsed) {
      const familyId = resolver.familyOf(name);
      if (familyId === undefined) continue;
      // The safety rule: a member is withheld only when its gateway rides the
      // same wire. Hiding it without the gateway would leave a tool the model
      // cannot reach at all, which is worse than paying for its schema.
      if (!present.has(gatewayNameFor(familyId))) continue;
      hidden.add(name);
    }

    // Report the surface that this round actually carries, so the notice, the
    // interception layers and the settings page all describe the same wire.
    // `extra` holds gateways this round appended itself; they ride the wire, so
    // the reported surface has to carry them too or the notice, the interception
    // layers and the settings page would describe a wire one round behind.
    const onWire = [...definitions.filter((definition) => !hidden.has(definition?.name)), ...extra].sort(
      (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    );
    state.adopt(onWire, [...hidden]);

    // Only touch the session record when the answer moved: a plain turn repeats
    // it, and rewriting identical bytes would defeat the prompt cache.
    const signature = [
      definitions.length,
      [...hidden].sort().join("\u0000"),
      extra.map((definition) => definition.name).sort().join("\u0000"),
    ].join("\u0001");
    if (state.surfaceSignature !== signature) {
      state.surfaceSignature = signature;
      logger?.debug?.(
        `dsh-tool-gate: hiding ${hidden.size} of ${definitions.length} tool(s) at the provider`
          + ` (agent ${state.id || "?"})`,
      );
      writeGateRecord(agent?.session, state, onWire.map((definition) => definition.name), logger);
    }

    return extra.length > 0 ? { hidden, extra } : hidden;
  };

  /**
   * Install the per-agent wire filter, if this host owns tools that way.
   *
   * On DSH 0.2.2 the waterfall no longer carries `tools`, so the only way to
   * remove a definition from the request is the scope's executor:
   * `ToolsService` asks `selectExecutor(scope).describe(definitions)` for the
   * provider result, and an agent-scoped executor shadows the deployment
   * default. `presentation.js` wraps the ambient executor and filters only
   * `describe()`, so execution is untouched.
   *
   * Returns `undefined` on hosts that still honour `assembly.tools` (<= 0.2.1),
   * which is also the signal that the legacy freeze path should run.
   */
  const installExecutorFilter = createExecutorFilter({ logger, plan: planProviderSurface });

  /**
   * Whether a family is collapsed in this session — the precondition for both
   * gateway access and prompt disclosure. Unknown ids answer `false`.
   */
  const isCollapsedFamily = (familyId) => {
    const family = families[familyId];
    return family !== undefined && family.enabled !== false;
  };

  /**
   * Every tool schema the registry currently exposes to `agent`.
   *
   * `schemas()` deep-clones each tool's parameter dictionary, so calling it per
   * family is not a micro-optimisation problem — the page used to pay it once
   * per family. Falls back to the global scope when the scoped read throws,
   * because a page that shows counts must never throw.
   *
   * Returns `undefined` when the registry could not be read at all. That case
   * must stay distinguishable from "the registry is empty": callers that treat
   * an unreadable registry as empty would conclude every family has no members.
   */
  const registrySchemas = (agent) => {
    try {
      return typeof ctx.tools?.schemas === "function" ? ctx.tools.schemas(agent) : [];
    } catch {
      try {
        return typeof ctx.tools?.schemas === "function" ? ctx.tools.schemas() : [];
      } catch {
        return undefined;
      }
    }
  };

  /** The single object every module receives; all fields are live reads. */
  const runtime = {
    ctx,
    logger,
    config: () => refreshFamilies(),
    families: () => families,
    stateFor: (agent) => states.ensure(agent),
    familyOf: (toolName) => resolver.familyOf(toolName),
    gatewayNameFor,
    labelFor,
    isCollapsedFamily,
    /** Every name that is resident by definition, including user pins. */
    residentNames: () => residentNames(currentConfig().residentTools ?? []),
    /**
     * The single residency predicate.
     *
     * Exposed because the settings page has to answer "how many of this family's
     * members can actually be saved?" with the same rule the surface used. The old
     * page counted every member, which is why a card promised 18 tools and 7133
     * tokens for a family where seven were permanent and eleven were hidden.
     */
    isResident,
    /** Full ownership identity (package, specifier, evidence, confidence). */
    identityOf: (name) => ownerIndex.identityOf(name),
    /** Identity for every name in `known` (defaults to the whole registry). */
    identities: (known) => ownerIndex.identities?.(known ?? knownNames()),
    /** Loader specifiers seen per package, for config-key aliases. */
    specifiers: () => ownerIndex.specifiers?.(),
    /** Diagnostics from the last attribution verification pass. */
    verification: () => ownerIndex.verification?.() ?? [],
    /** Attribution corrections the verifier applied. */
    repairs: () => ownerIndex.repairs?.(),
    /** What the last family resolution did with the user's config keys. */
    report: () => familyReport,
    /** Per-family degenerate assessments for one scope (see `degenerate.js`). */
    assessments(agent) {
      const schemas = registrySchemas(agent);
      return schemas === undefined ? undefined : assessmentsOf(schemas);
    },
    /**
     * Everything `describe().diagnostics` needs, in one object.
     *
     * Kept as an input bundle rather than a finished diagnostic list because the
     * `ungrouped` rows — which D3 checks — are built in `bridge.js`, and the check
     * has to see the rows the page actually renders, not a second opinion of them.
     */
    diagnosticsInputs(agent) {
      const scope = agent ?? runtime.primaryAgent?.();
      const schemas = registrySchemas(scope);
      const gateways = new Map();
      for (const family of Object.values(families)) gateways.set(family.id, gatewayNameFor(family.id));
      return {
        families,
        owners: ownerIndex.registered(knownNames()),
        identities: ownerIndex.identities?.(knownNames()),
        membersByFamily: runtime.membersByFamily(scope),
        gateways,
        toolNames: [...knownNames()],
        isResident,
        assessments: schemas === undefined ? undefined : assessmentsOf(schemas),
        report: familyReport,
      };
    },
    /**
     * Live members of one family, read from the registry (not the wire).
     *
     * `agent` matters: `tools.schemas()` without a scope sees only the global
     * layer, so a plugin that registers from inside a scoped `ctx.inject` — the
     * schedule bundle does — would report zero members while its tools are live.
     * Callers pass the agent whose session is being described.
     */
    membersOf(familyId, agent) {
      const out = [];
      for (const schema of registrySchemas(agent) ?? []) {
        if (typeof schema?.name !== "string") continue;
        if (resolver.familyOf(schema.name) === familyId) out.push(schema);
      }
      out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      return out;
    },
    /**
     * Every family's members from ONE registry read.
     *
     * `describe()` needs all families at once, and calling `membersOf` per family
     * re-read (and deep-clones) the whole registry once per family — for 13
     * families that is 13× the work for one page load. This returns the same
     * shape keyed by family id, or `undefined` when the registry is unreadable
     * (callers must not read that as "every family is empty").
     */
    membersByFamily(agent) {
      const schemas = registrySchemas(agent);
      if (schemas === undefined) return undefined;
      const out = new Map();
      for (const schema of schemas) {
        if (typeof schema?.name !== "string") continue;
        const familyId = resolver.familyOf(schema.name);
        if (familyId === undefined) continue;
        let list = out.get(familyId);
        if (list === undefined) out.set(familyId, (list = []));
        list.push(schema);
      }
      for (const list of out.values()) {
        list.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      }
      return out;
    },
    /**
     * The agent whose scope best describes the live session, for inspections.
     *
     * Prefers the agent with the largest frozen surface — subagents legitimately
     * see fewer tools — and falls back to the most recently attached one before
     * any assembly has happened.
     */
    primaryAgent() {
      let best;
      for (const state of states) {
        if (best === undefined) best = state;
        if ((state.frozen?.length ?? 0) > (best.frozen?.length ?? 0)) best = state;
      }
      return best?.agent;
    },
    /**
     * Names on the wire right now, for the settings page summary.
     *
     * Subagent scopes see a smaller registry (they lack some OPS tools), so the
     * largest frozen surface is the one that describes the main session.
     */
    wireNames() {
      let best = [];
      for (const state of states) {
        if (Array.isArray(state.frozen) && state.frozen.length > best.length) best = state.frozen;
      }
      return best.length > 0 ? best.map((schema) => schema.name) : gatewayNames;
    },
    /**
     * Every package the page should offer a switch for.
     *
     * The user asked for one switch per third-party plugin, *whether or not* it
     * injects prose today — a whitelist of the three plugins that happen to inject
     * something would have to be edited every time a plugin starts doing it. So
     * this unions three sources and lets the row say what it actually controls:
     *
     *  - packages owning tools (the owner index),
     *  - packages named by a family definition,
     *  - packages the disclosure engine can already attribute prose to.
     *
     * @returns rows sorted by package name.
     */
    packages() {
      const rows = new Map();
      const row = (raw) => {
        // One row per package, not per Loader entry: `dsh-ops/discovery`,
        // `dsh-ops/mode-cordis` and `dsh-ops/mode-ptc` are three entries of one
        // package, and listing them separately made the page look like it had
        // found plugins that do not exist.
        const pkg = barePackageName(raw) ?? raw;
        let entry = rows.get(pkg);
        if (entry === undefined) {
          entry = {
            package: pkg,
            thirdParty: !isHarnessPackage(pkg),
            families: [],
            tools: [],
          };
          rows.set(pkg, entry);
        }
        return entry;
      };

      for (const [toolName, pkg] of Object.entries(ownerIndex.registered(knownNames()))) {
        // `mcp:<server>` is a server identity, not a package: an MCP server ships
        // no code here, so it gets no switch. Its tools still belong to the
        // `mcp_servers` family, which has its own row.
        if (typeof pkg !== "string" || pkg === UNKNOWN || pkg.startsWith("mcp:")) continue;
        const entry = row(pkg);
        entry.tools.push(toolName);
        const family = resolver.familyOf(toolName);
        if (family !== undefined && !entry.families.includes(family)) entry.families.push(family);
      }
      for (const family of Object.values(families)) {
        for (const pkg of family.packages ?? []) row(pkg).families.push(family.id);
      }
      // Packages that inject prose but own no tool: a prompt-only plugin has no
      // family (no tool means no gateway to carry the prose), so without this it
      // would vanish from the page and its text would look like a leak.
      for (const entry of disclosure.inventory()) row(entry.package);
      // Only the family flags are read now; `promptPlugins` is cleared by the
      // migration and must not repopulate the list with rows that have no switch.
      refreshFamilies();

      const out = [...rows.values()];
      for (const entry of out) {
        entry.tools.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        entry.families = [...new Set(entry.families)].sort();
      }
      out.sort((a, b) => (a.package < b.package ? -1 : a.package > b.package ? 1 : 0));
      return out;
    },
    /**
     * Re-derive everything the settings page shows, from scratch.
     *
     * Three caches stand between "a plugin was installed" and "the page lists it",
     * and each one is invisible from the outside:
     *
     *  - `tool-scan.js` memoizes the bundle index per profile root. It is now
     *    fingerprinted on the profile manifest, so an install invalidates it — but
     *    a manifest rewritten to the same length within one mtime tick would not;
     *  - `owner.js` memoizes `registered()` on a revision counter that only moves
     *    when *this process* sees a registration or a disposal, so a plugin
     *    installed by another process moved nothing;
     *  - `refreshFamilies()` skips the rebuild when the signature matches, and the
     *    signature is built from the owner snapshot — so a stale owner snapshot
     *    produces a matching signature and no rebuild.
     *
     * Each is dropped here, in that order, and the family table is then rebuilt
     * unconditionally. The wire is untouched: this changes what the page can see,
     * not what the model sees in the current session — a newly installed plugin
     * starts collapsing in the *next* session, which is what the page says.
     */
    refreshInventory() {
      try {
        forgetScanCache();
      } catch (error) {
        logger?.debug?.(`dsh-tool-gate: scan cache reset failed (${String(error?.message ?? error)})`);
      }
      try {
        ownerIndex.forget();
      } catch (error) {
        logger?.debug?.(`dsh-tool-gate: owner cache reset failed (${String(error?.message ?? error)})`);
      }
      tokenWeights.clear();
      return refreshFamilies({ force: true });
    },
  };

  // ——— prompt disclosure ————————————————————————————————————————————
  const disclosure = createPromptDisclosure({
    ctx,
    logger,
    config: runtime.config,
    families: runtime.families,
    familyOf: runtime.familyOf,
    isCollapsedFamily,
  });

  // ——— gateways ————————————————————————————————————————————————————
  /** Names currently registered. */
  let gatewayNames = [];
  /** `Map<name, { familyId, dispose }>` — what is actually mounted right now. */
  const mountedGateways = new Map();

  /**
   * Register or withdraw the gateways to match `enabled` and the family table.
   *
   * Withdrawing matters: a gateway registered while the plugin is off would put
   * extra tools on the wire for nothing, and `enabled: false` has to mean
   * "this plugin never touched anything".
   *
   * This runs inside the assemble hook, so it must not churn: it reconciles by
   * name and leaves every unchanged gateway alone (see `reconcileGateways`).
   */
  /**
   * Every family id that has no members anyone can call.
   *
   * A family is derived from ownership, so an id normally implies members. The
   * exceptions are config-declared families (`families: { x: { packages: [...] } }`)
   * and overrides whose plugin registers no tools — a prompt-only plugin, or a
   * table entry that outlived its plugin. Such a family has nothing behind a
   * gateway: `list` could only answer "no members", and the wire would carry a
   * tool that does nothing. Those gateways are not registered, and the page marks
   * the rows hidden.
   *
   * Emptiness is judged against {@link callableNames}, not `knownNames()`. Using
   * the wider set here is exactly the bug that put `fs_search` on the wire with
   * zero members: `knownNames()` includes the scope-less unrestricted view, so
   * names restricted out of every agent still counted as members. The page has
   * always counted through `schemas(agent)`, and the two must agree — otherwise
   * the model sees a gateway whose row the user cannot see, or the reverse.
   *
   * @param primaryScope - the agent whose assembly is in flight, if any.
   */
  const emptyFamilyIds = (primaryScope) => {
    const out = new Set();
    const ids = Object.keys(families);
    if (ids.length === 0) return out;
    const callable = callableNames(primaryScope);
    // Nothing is callable yet (no scope has been readable): an empty answer here
    // would withdraw every gateway on a transient, so suppress none.
    if (callable.size === 0) return out;
    const populated = new Set();
    for (const name of callable) {
      const familyId = resolver.familyOf(name);
      if (familyId !== undefined) populated.add(familyId);
    }
    for (const id of ids) if (!populated.has(id)) out.add(id);
    return out;
  };

  /**
   * Family ids that must not have a gateway on the wire.
   *
   * Two disjoint reasons, one list, because a gateway exists only to hide someone:
   *
   *  - **no members** (`emptyFamilyIds`): there is nobody behind the door;
   *  - **nothing worth hiding** (`degenerate.js`): the members are all resident, or
   *    too small to pay for the gateway.
   *
   * The second half is the reverse of the old safety rule ("藏人必有门"). Hiding a
   * member whose gateway is missing leaves a tool nothing can reach; mounting a
   * gateway that hides nobody is the harmless-looking version of the same mistake —
   * it just pays tokens for a tool that answers "no members". Together the two
   * directions give one invariant: **a gateway and its collapsible members are born
   * and die together.**
   *
   * An unreadable registry answers `undefined` from `collapsibleSetOf`, which
   * suppresses nothing — a transient read failure must not withdraw every gateway.
   */
  const withheldFamilyIds = (scope) => {
    const out = emptyFamilyIds(scope);
    const schemas = registrySchemas(scope);
    if (schemas === undefined) return out;
    const allow = collapsibleSetOf(schemas);
    if (allow === undefined) return out;
    for (const id of Object.keys(families)) if (!allow.has(id)) out.add(id);
    return out;
  };

  /** Gateway names present at the end of the previous reconcile. */
  let previousGatewayNames = new Set();
  /**
   * Every gateway name this session has ever withdrawn.
   *
   * Needed because the host collects tool schemas *before* it runs this waterfall,
   * so the list being filtered still contains a gateway that was disposed earlier
   * in the same pass. Left alone it would be frozen in as an "unknown tool" and —
   * since the frozen surface is sticky — stay on the wire for the rest of the
   * session, which is the very unreachability the unfreeze below exists to avoid.
   */
  const everWithdrawn = new Set();

  /**
   * A withdrawn gateway has to un-freeze its agents.
   *
   * `state.adopt()` is sticky by design (that is what makes the wire prefix
   * byte-stable), so a gateway that disappears from the registry — a family
   * emptied out, a `families.*.enabled: false` arriving mid-session — would stay
   * in every agent's frozen surface for the rest of the session while its members
   * remained collapsed: a family nobody can reach.
   *
   * Only *withdrawal* un-freezes. A newly mounted gateway is handled by the
   * pending-splice in `handleAssemble` instead, precisely so that turning a family
   * back on does not rebuild every agent's surface.
   */
  const unfreezeIfWithdrawn = (names) => {
    const current = new Set(names);
    const withdrawn = [...previousGatewayNames].filter((name) => !current.has(name));
    previousGatewayNames = current;
    // A name that is back in the inventory is no longer "ever withdrawn".
    for (const name of current) everWithdrawn.delete(name);
    if (withdrawn.length === 0) return;
    for (const name of withdrawn) everWithdrawn.add(name);
    let touched = 0;
    for (const state of states) {
      if (state.frozen === undefined) continue;
      state.frozen = undefined;
      state.collapsed = [];
      state.collapsedNames = new Set();
      state.ready = false;
      state.surfaceSignature = undefined;
      state.noticeText = undefined;
      // A withdrawn gateway must also stop hiding its members at the provider,
      // or the family becomes unreachable until the next session.
      state.executorFilter?.hidden.clear();
      touched += 1;
    }
    logger?.debug?.(
      `dsh-tool-gate: gateway(s) withdrawn (${withdrawn.join(", ")}); re-freezing ${touched} agent(s)`,
    );
  };

  const syncGateways = (enabled, scope) => {
    if (!enabled) {
      for (const [name, entry] of [...mountedGateways]) {
        try {
          entry.dispose();
        } catch {
          /* already gone */
        }
        mountedGateways.delete(name);
        unscannable.delete(name);
      }
      gatewayNames = [];
      unfreezeIfWithdrawn(gatewayNames);
      return;
    }
    gatewayNames = reconcileGateways({
      ctx,
      families,
      gatewayNameFor,
      runtime,
      logger,
      mounted: mountedGateways,
      unscannable,
      emptyFamilies: withheldFamilyIds(scope),
    });
    unfreezeIfWithdrawn(gatewayNames);
  };
  syncGateways(currentConfig().enabled === true);

  /**
   * Reconcile gateways the moment the registry moves.
   *
   * The gateways must exist *before* the provider collects a round's tool list,
   * because that list is what the collapse decision is taken against. Bundles
   * mount after this one and register their tools later, so the load-time pass
   * above sees an incomplete registry — waiting for the assemble waterfall would
   * put the gateways one round behind, and a family that appears mid-session
   * would never be foldable in the round it appears.
   *
   * `ctx.tools.register()` inside a reconcile emits `tools/change` again, so the
   * re-entrancy flag is load-bearing, not defensive noise.
   */
  let reconciling = false;
  const reconcileNow = (scope) => {
    if (reconciling) return;
    reconciling = true;
    try {
      // A tool's size is what the degenerate rule prices, and this is the one
      // signal that a schema changed. Dropping it here keeps `assessmentsOf` from
      // pricing a family against a stale weight for the rest of the session.
      tokenWeights.clear();
      const live = refreshFamilies();
      syncGateways(live.enabled === true, scope);
      // A filter whose install was refused earlier -- because this agent's scope
      // could not read the tools service yet, or because another plugin held the
      // executor slot -- gets another chance whenever the registry moves. Without
      // this, such an agent stays unfolded until its next session.
      for (const state of states) {
        if (state.executorFilter !== undefined) continue;
        installExecutorFilter(state.agent, state);
      }
      // An agent that reached this process without an `agent/created` listener
      // run (a registry entry restored from elsewhere) never got a filter. The
      // registry moving is the last moment that still precedes a request, so it
      // is the moment to catch up.
      try {
        for (const agent of ctx.get("agents")?.list?.() ?? []) {
          if (states.get(agent)?.executorFilter !== undefined) continue;
          attach(agent);
        }
      } catch {
        /* no agent registry in this host: `agent/created` is the only signal */
      }
    } catch (error) {
      logger?.warn?.(`dsh-tool-gate: gateway reconcile failed (${String(error?.message ?? error)})`);
    } finally {
      reconciling = false;
    }
  };
  ctx.on("tools/change", () => {
    reconcileNow(undefined);
    return undefined;
  });

  // ——— interception ————————————————————————————————————————————————
  const disposeInterception = installInterception({ ctx, runtime, logger });
  ctx.effect(() => () => disposeInterception(), "dsh-tool-gate: interception");

  // ——— per-agent state —————————————————————————————————————————————
  /** Give one agent a state object, and remember what a resumed session collapsed. */
  const attach = (agent) => {
    if (agent === undefined || agent === null) return undefined;
    const state = states.ensure(agent);
    if (state.restored === true) return state;
    state.restored = true;
    try {
      const row = agentRowOf(readGateRecord(agent.session), state.id);
      if (row !== undefined && Array.isArray(row.collapsed) && state.collapsed.length === 0) {
        // Names only: schemas are always rebuilt live, so a resumed session never
        // inherits a stale parameter shape from an older plugin version.
        state.collapsed = row.collapsed.filter((entry) => typeof entry === "string");
        state.collapsedNames = new Set(state.collapsed);
      }
    } catch (error) {
      logger?.debug?.(`dsh-tool-gate: could not restore gate record (${String(error?.message ?? error)})`);
    }
    // Install the wire filter as early as an agent exists. `attach()` runs from
    // `agent/created`, which precedes that agent's first provider call, so the
    // very first request of a session is already shaped by the gate. Waiting for
    // the first assemble would cost the first round of every session.
    //
    // Installed even while the gate is off: `planProviderSurface` returns an
    // empty set in that state, so the wrapper is transparent, and a user who
    // turns the gate on mid-session gets collapsing in the very next round
    // instead of losing one to the round where the flip is noticed.
    installExecutorFilter(agent, state);
    return state;
  };

  // M5: agents that already exist when the plugin mounts (reload, hot enable).
  try {
    for (const agent of ctx.get("agents")?.list?.() ?? []) attach(agent);
  } catch {
    /* the created hook below covers agents that appear later */
  }
  ctx.on("agent/created", ({ agent }) => {
    attach(agent);
    return undefined;
  });
  ctx.on("agent/disposed", ({ agent }) => {
    states.get(agent)?.releaseExecutorFilter();
    states.delete(agent);
  });

  // ——— the wire surface ————————————————————————————————————————————
  /**
   * Replace the assembled tool list with the frozen surface (DSH <= 0.2.1).
   *
   * The listener is deliberately idempotent: `dsh-ops` re-enters `assemble()` from
   * inside this very waterfall in several places, so this body can run twice for
   * one prompt. Once a surface is frozen we return the *same array reference*,
   * which is what keeps the bytes identical.
   */
  /**
   * The 0.2.2 path: hide tools at the provider, not in the waterfall.
   *
   * Everything below the branch in `handleAssemble` (the gateway splice, the
   * frozen array, `result.tools`) is meaningless here because the host never
   * reads that field. What still works is the same decision procedure:
   *
   *  1. read the registry view the provider will publish (`schemas(agent)`),
   *  2. run it through `buildFrozenSurface` to learn *which names* collapse,
   *  3. hand that name set to the agent's executor filter, which removes exactly
   *     those definitions from `describe()`.
   *
   * The registry is never touched, so `action: "list"` (which reads
   * `tools.schemas()`) still sees every member, and the gateway can still
   * dispatch any of them.
   *
   * Freezing is honoured in the sense that matters here: the surface is recomputed
   * only when its inputs changed (a different registry, `freeze: false`, or a
   * withdrawn gateway). A plain turn repeats the same names, so the prefix stays
   * byte-identical and the prompt cache still hits.
   *
   * @param result - the waterfall result to return.
   * @param agent - the scope being assembled.
   * @param live - the current config snapshot.
   * @returns the assembly with the notice section, no `tools` key added.
   */
  const handleProviderOwnedAssemble = (result, agent, live) => {
    const state = states.ensure(agent);
    // Idempotent, and normally a no-op here: `attach()` installs the filter when
    // the agent appears, which is the earliest point that still precedes the
    // first provider call. Doing it again covers an agent this plugin attached
    // before the tools service was reachable.
    installExecutorFilter(agent, state);

    // Nothing to compute here. The hidden set is decided inside `describe()`
    // (`planProviderSurface`), where the definition list for *this* round is in
    // hand, and that is the only place it can be decided without costing a round.
    // `state` therefore already describes the wire the model is about to receive.

    // Prompt-side work matches the legacy path: keep what was captured for `list`,
    // and append the notice once.
    let sections = result.sections;
    if (live.promptDisclosure === true) {
      const captured = disclosure.collect();
      if (Object.keys(captured).length > 0) state.promptText = captured;
    }
    if (live.staticNotice !== false && Array.isArray(sections)) {
      if (state.noticeText === undefined) {
        state.noticeText = buildNotice(state.collapsed, resolver.familyOf, families, gatewayNameFor);
      }
      const present = sections.some((section) => section?.name === NOTICE_SECTION);
      if (state.noticeText !== undefined && !present) {
        sections = [...sections, { name: NOTICE_SECTION, text: state.noticeText }];
      }
    }

    if (sections === result.sections) return result;
    return { ...result, sections };
  };

  const handleAssemble = async (assembly, context, next) => {
    const live = refreshFamilies();
    // Register before `next()`: the registry feeds the assembly this hook filters.
    // The scope is passed through so emptiness is judged against what this agent
    // can actually call, not against a scope-less superset (see `callableNames`).
    syncGateways(live.enabled === true, context?.scope);

    const result = await next();
    if (live.enabled !== true) {
      // A disable must also lift the hiding, or the tools stay off the wire with
      // nothing left to reach them. It must not dispose the wrapper: see
      // `AgentState.showAll()`.
      for (const state of states) state.showAll();
      return result;
    }

    const agent = context?.scope;
    if (agent === undefined || agent === null) return result;

    // DSH 0.2.2 kept tool declarations provider-owned: the waterfall carries
    // sections, contexts and variables, and the host re-attaches the provider's
    // list afterwards. Replacing `tools` there is discarded, so the surface is
    // filtered where the provider is asked for it instead (`presentation.js`).
    if (!Array.isArray(result?.tools)) {
      return handleProviderOwnedAssemble(result, agent, live);
    }

    const wireNames = result.tools
      .map((schema) => schema?.name)
      .filter((entry) => typeof entry === "string");

    // A collapsed (PTC) scope receives `run_code` and nothing else. There is
    // nothing to collapse there, and freezing would fight the host: step aside.
    if (live.ptcMode !== "ignore" && wireNames.length > 0 && wireNames.every((entry) => entry === RUN_CODE)) {
      states.ensure(agent).ptc = true;
      return result;
    }

    // A gateway registered during THIS pass is missing from the assembly it is
    // filtering: the host collects tool schemas *before* it runs this waterfall.
    // Filtering the stale list would drop that gateway from the frozen surface,
    // and the frozen surface is sticky — the family would stay unreachable for the
    // rest of the session. So splice the freshly registered gateways back in; they
    // are ordinary registered tools by now and `schemas()` can see them.
    let source = result.tools;
    // The assembly was collected before the reconcile above, so it still carries
    // any gateway withdrawn in this pass. Dropping them here is what makes the
    // withdrawal visible immediately instead of at the next session.
    if (everWithdrawn.size > 0 && source.some((schema) => everWithdrawn.has(schema?.name))) {
      source = source.filter((schema) => !everWithdrawn.has(schema?.name));
    }
    const pending = gatewayNames.filter((name) => !wireNames.includes(name));
    if (pending.length > 0) {
      const available = new Map();
      try {
        for (const schema of ctx.tools.schemas(agent) ?? []) available.set(schema.name, schema);
      } catch {
        /* fall through to the deferral below */
      }
      const extra = pending.map((name) => available.get(name)).filter((schema) => schema !== undefined);
      if (extra.length > 0) source = [...source, ...extra];
      const stillMissing = pending.filter((name) => !available.has(name));
      if (stillMissing.length > 0) {
        // Registration genuinely failed; better one unfiltered round than a
        // permanently unreachable family.
        logger?.debug?.(`dsh-tool-gate: gateway(s) not resolvable yet: ${stillMissing.join(", ")}`);
        states.ensure(agent).frozen = undefined;
        return result;
      }
    }

    const state = states.ensure(agent);
    let frozen = state.frozen;
    if (frozen === undefined || live.freeze === false) {
      const built = buildFrozenSurface(source, {
        familyOf: resolver.familyOf,
        families,
        alwaysExpose: live.alwaysExpose ?? [],
        alwaysHide: live.alwaysHide ?? [],
        unknownOwnerPolicy: live.unknownOwnerPolicy === "collapse" ? "collapse" : "expose",
        keepNames: new Set(gatewayNames),
        residentTools: live.residentTools ?? [],
        isResident,
        collapsibleFamilies: collapsibleSetOf(source),
      });
      frozen = built.tools;
      state.adopt(frozen, built.collapsed);
      logger?.debug?.(
        `dsh-tool-gate: froze ${frozen.length} wire tool(s), collapsed ${built.collapsed.length}`
          + ` (agent ${state.id || "?"})`,
      );
      writeGateRecord(agent.session, state, frozen.map((schema) => schema.name), logger);
    }

    // Prompt disclosure: the plugins' prose is withheld at its registration (see
    // `prompt-scan.js`), so there is nothing to rewrite here — just take what was
    // dropped and keep it for this agent's `action: "list"`.
    let sections = result.sections;
    if (live.promptDisclosure === true) {
      const captured = disclosure.collect();
      if (Object.keys(captured).length > 0) state.promptText = captured;
    }

    if (live.staticNotice !== false && Array.isArray(sections)) {
      // Built once: prompt-prefix text must not drift between turns.
      if (state.noticeText === undefined) {
        state.noticeText = buildNotice(state.collapsed, resolver.familyOf, families, gatewayNameFor);
      }
      const present = sections.some((section) => section?.name === NOTICE_SECTION);
      if (state.noticeText !== undefined && !present) {
        // The host drops extra sections for a scope that owns a `complete`
        // section (a persona), which is the correct outcome there.
        sections = [...sections, { name: NOTICE_SECTION, text: state.noticeText }];
      }
    }

    if (sections === result.sections && frozen === result.tools) return result;
    return { ...result, tools: frozen, sections };
  };

  ctx.on("system-prompt/assemble", handleAssemble);

  // ——— settings page bridge ————————————————————————————————————————
  // `webServer` is composed after this bundle in the profile's layer order, so it
  // is resolved through `ctx.inject`, which fires once the service exists.
  ctx.inject(["webServer"], (sctx) => {
    const disposeBridge = registerBridge(sctx, { runtime, disclosure, logger });
    if (disposeBridge !== undefined) {
      sctx.effect(() => () => disposeBridge(), "dsh-tool-gate: settings bridge");
    }
  });

  // ——— teardown ————————————————————————————————————————————————————
  ctx.effect(
    () => () => {
      for (const [, entry] of [...mountedGateways]) {
        try {
          entry.dispose();
        } catch {
          /* already gone */
        }
      }
      mountedGateways.clear();
      unscannable.clear();
      gatewayNames = [];
      for (const state of states) state.releaseExecutorFilter();
      disclosure.dispose();
      ownerIndex.dispose();
      metaReader.dispose();
    },
    "dsh-tool-gate: gateways, disclosure and attribution",
  );
}

export default { name, inject, Config, apply };
