/**
 * dsh-tool-gate — progressive disclosure for DSH tools.
 *
 * The goal is narrow and measurable: keep the wire `tools` array **byte-identical**
 * across turns while letting third-party families of tools live behind a handful
 * of stable gateway tools. Every held-out tool definition is prefix the provider
 * would otherwise re-read (and, with prompt caching, re-pay for on every turn that
 * changes anything else in the prefix).
 *
 * Three facts make this safe, all verified against the host:
 *
 *  1. The value returned by the `system-prompt/assemble` waterfall is authoritative
 *     for the tool list, so a listener can replace it.
 *  2. Execution does not consult that list: `dispatchToolBody` resolves the
 *     definition from the registry, so a collapsed tool still runs.
 *  3. The request header only changes when the assembled tool bytes change, so a
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
import { registerBridge } from "./bridge.js";
import { installInterception } from "./guard.js";
import { createOwnerIndex, SELF_PACKAGE_NAME, UNKNOWN } from "./owner.js";
import { migratePromptPlugins } from "./migrate.js";
import { isHarnessPackage } from "./ownership-channel.js";
import { createPromptDisclosure } from "./prompt-scan.js";
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
 * It is cached on the agent state on purpose: the notice is prompt-prefix text, so
 * it has to be byte-identical on every turn. Recomputing it from a live membership
 * count would quietly reintroduce the cache miss this plugin exists to remove.
 */
function buildNotice(collapsed, familyOf, families, gatewayNameFor) {
  const ids = new Set();
  for (const name of collapsed) {
    const family = familyOf(name);
    if (family !== undefined) ids.add(family);
  }
  if (ids.size === 0) return undefined;
  const lines = [...ids].sort().map((id) => {
    const family = families[id];
    const label = family?.label || id;
    return `- \`${gatewayNameFor(id)}\` — ${label}${family?.description ? `：${family.description}` : ""}`;
  });
  return [
    "## 工具网关（渐进披露）",
    "",
    "下列家族的工具定义不在本轮工具列表里（会话内保持收起，以稳定提示前缀）。它们全部通过同名网关工具访问：",
    "",
    ...lines,
    "",
    "每个网关两个动作：`action: \"list\"` 返回该家族全部成员的名字、说明与完整参数定义；"
      + "`action: \"call\"` 配 `tool` 与 `arguments` 调用成员，返回值与直接调用一致。",
    "成员定义在第一次 `list` 之前不占上下文；`list` 过一次后不必重复调用。",
    "直接调用已收起成员的名字会被拦截并提示改走网关——那不是工具本身的错误。",
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
  });
  const states = createStateStore();

  const gatewayNameFor = (familyId) =>
    gatewayName(currentConfig().gatewayPrefix, familyId, families[familyId]?.gateway);
  const labelFor = (familyId) => families[familyId]?.label || familyId;

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
   * Resolve the family table from the live registry.
   *
   * Discovery reads the owner snapshot, so the answer changes when a plugin is
   * installed, removed, or enabled — not only when the config changes. The
   * signature covers both inputs, and the derived table is cheap enough (one pass
   * over a few hundred names) to rebuild whenever either moves.
   */
  const resolveNow = (live, owners) =>
    resolveFamilies(live.families, {
      builtinEnabled: live.builtinFamilies !== false,
      auto: live.autoFamilies !== false,
      owners: owners ?? ownerIndex.registered(knownNames()),
      selfPackage: SELF_PACKAGE_NAME,
      residentTools: live.residentTools ?? [],
    });

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

  /** Keep the family table in step with live config and registry edits. */
  const refreshFamilies = () => {
    const live = currentConfig();
    const owners = ownerIndex.registered(knownNames());
    const signature = signatureOf(live, owners);
    if (signature !== familySignature) {
      familySignature = signature;
      families = resolveNow(live, owners);
      resolver = createFamilyResolver(families, ownerIndex.ownerOf, gatewayNameFor);
    }
    return live;
  };

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
      const row = (pkg) => {
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
   * Every family id that currently has no members.
   *
   * A family is derived from ownership, so an id normally implies members. The
   * exceptions are config-declared families (`families: { x: { packages: [...] } }`)
   * and overrides whose plugin registers no tools — a prompt-only plugin, or a
   * table entry that outlived its plugin. Such a family has nothing behind a
   * gateway: `list` could only answer "no members", and the wire would carry a
   * tool that does nothing. Those gateways are not registered, and the page
   * marks the rows hidden.
   */
  /**
   * Every family id that currently has no members.
   *
   * A family is derived from ownership, so an id normally implies members. The
   * exceptions are config-declared families (`families: { x: { packages: [...] } }`)
   * and overrides whose plugin registers no tools — a prompt-only plugin, or a
   * table entry that outlived its plugin. Such a family has nothing behind a
   * gateway: `list` could only answer "no members", and the wire would carry a
   * tool that does nothing. Those gateways are not registered, and the page
   * marks the rows hidden.
   *
   * Emptiness is judged against `knownNames()` — the same set the families were
   * derived from — and not against one agent's view. A scope-less registry read
   * cannot see tools registered inside an agent's `ctx.inject` (the schedule
   * bundle does exactly that), so judging by that alone would call a populated
   * family empty and withdraw its gateway while its tools are collapsed out of
   * the wire, making them unreachable.
   */
  const emptyFamilyIds = () => {
    const out = new Set();
    const ids = Object.keys(families);
    if (ids.length === 0) return out;
    const known = knownNames();
    // Nothing is known yet (the registry has not been read once): an empty
    // answer here would withdraw every gateway on a transient, so suppress none.
    if (known.size === 0) return out;
    const populated = new Set();
    for (const name of known) {
      const familyId = resolver.familyOf(name);
      if (familyId !== undefined) populated.add(familyId);
    }
    for (const id of ids) if (!populated.has(id)) out.add(id);
    return out;
  };

  const syncGateways = (enabled) => {
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
      emptyFamilies: emptyFamilyIds(),
    });
  };
  syncGateways(currentConfig().enabled === true);

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
    states.delete(agent);
  });

  // ——— the wire surface ————————————————————————————————————————————
  /**
   * Replace the assembled tool list with the frozen surface.
   *
   * The listener is deliberately idempotent: `dsh-ops` re-enters `assemble()` from
   * inside this very waterfall in several places, so this body can run twice for
   * one prompt. Once a surface is frozen we return the *same array reference*,
   * which is what keeps the bytes identical.
   */
  const handleAssemble = async (assembly, context, next) => {
    const live = refreshFamilies();
    // Register before `next()`: the registry feeds the assembly this hook filters.
    syncGateways(live.enabled === true);

    const result = await next();
    if (live.enabled !== true) return result;
    if (!Array.isArray(result?.tools)) return result;

    const agent = context?.scope;
    if (agent === undefined || agent === null) return result;

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
    const pending = gatewayNames.filter((name) => !wireNames.includes(name));
    if (pending.length > 0) {
      const available = new Map();
      try {
        for (const schema of ctx.tools.schemas(agent) ?? []) available.set(schema.name, schema);
      } catch {
        /* fall through to the deferral below */
      }
      const extra = pending.map((name) => available.get(name)).filter((schema) => schema !== undefined);
      if (extra.length > 0) source = [...result.tools, ...extra];
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
      disclosure.dispose();
      ownerIndex.dispose();
    },
    "dsh-tool-gate: gateways, disclosure and attribution",
  );
}

export default { name, inject, Config, apply };
