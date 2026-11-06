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
} from "./families.js";
import { registerGateways } from "./gateways.js";
import { registerBridge } from "./bridge.js";
import { installInterception } from "./guard.js";
import { createOwnerIndex, SELF_PACKAGE_NAME, UNKNOWN } from "./owner.js";
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

/**
 * Package-name prefixes that mark first-party code.
 *
 * Used only to label a plugin row in the settings page ("内置" vs "第三方"); it
 * never gates behaviour, because the user asked for a switch on *every* plugin.
 */
const THIRD_PARTY_PREFIXES = ["@deepseek-ai/", "@dsh-ops/"];

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

  const ownerIndex = createOwnerIndex(ctx, logger);
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
   */
  const knownNames = () => {
    const names = new Set();
    const collect = (scope) => {
      try {
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
  const resolveNow = (live) =>
    resolveFamilies(live.families, {
      builtinEnabled: live.builtinFamilies !== false,
      auto: live.autoFamilies !== false,
      owners: ownerIndex.registered(knownNames()),
      selfPackage: SELF_PACKAGE_NAME,
    });

  /** Signature inputs: the override dict, the switches, and the live registry. */
  const signatureOf = (live) =>
    JSON.stringify([
      live.families ?? {},
      live.builtinFamilies !== false,
      live.autoFamilies !== false,
      ownerIndex.registered(knownNames()),
    ]);

  let families = resolveNow(currentConfig());
  let resolver = createFamilyResolver(families, ownerIndex.ownerOf, gatewayNameFor);
  let familySignature = signatureOf(currentConfig());

  /** Keep the family table in step with live config and registry edits. */
  const refreshFamilies = () => {
    const live = currentConfig();
    const signature = signatureOf(live);
    if (signature !== familySignature) {
      familySignature = signature;
      families = resolveNow(live);
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
    /**
     * Live members of one family, read from the registry (not the wire).
     *
     * `agent` matters: `tools.schemas()` without a scope sees only the global
     * layer, so a plugin that registers from inside a scoped `ctx.inject` — the
     * schedule bundle does — would report zero members while its tools are live.
     * Callers pass the agent whose session is being described.
     */
    membersOf(familyId, agent) {
      let all = [];
      try {
        all = typeof ctx.tools?.schemas === "function" ? ctx.tools.schemas(agent) : [];
      } catch {
        try {
          all = typeof ctx.tools?.schemas === "function" ? ctx.tools.schemas() : [];
        } catch {
          all = [];
        }
      }
      const out = [];
      for (const schema of all) {
        if (typeof schema?.name !== "string") continue;
        if (resolver.familyOf(schema.name) === familyId) out.push(schema);
      }
      out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
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
            thirdParty: !THIRD_PARTY_PREFIXES.some((prefix) => pkg.startsWith(prefix)),
            families: [],
            tools: [],
          };
          rows.set(pkg, entry);
        }
        return entry;
      };

      for (const [toolName, pkg] of Object.entries(ownerIndex.registered())) {
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
      const live = refreshFamilies();
      for (const pkg of Object.keys(live.promptPlugins ?? {})) row(pkg);

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
  /** Names currently registered, and their disposer. */
  let gatewayNames = [];
  let disposeGateways = undefined;
  /** Which family/enable state the mounted gateways were built from. */
  let gatewaySignature = "";

  /**
   * Register or withdraw the gateways to match `enabled` and the family table.
   *
   * Withdrawing matters: a gateway registered while the plugin is off would put
   * extra tools on the wire for nothing, and `enabled: false` has to mean
   * "this plugin never touched anything".
   */
  const syncGateways = (enabled) => {
    const signature = enabled
      ? `on|${gatewayNameFor("")}|${Object.values(families)
          .filter((family) => family.enabled !== false)
          .map((family) => family.id)
          .sort()
          .join(",")}`
      : "off";
    if (signature === gatewaySignature) return;
    if (disposeGateways !== undefined) {
      disposeGateways();
      disposeGateways = undefined;
    }
    gatewaySignature = signature;
    if (!enabled) return;
    const mounted = registerGateways({ ctx, families, gatewayNameFor, runtime, logger });
    gatewayNames = mounted.names;
    disposeGateways = () => {
      for (const dispose of mounted.disposers.splice(0)) {
        try {
          dispose();
        } catch {
          /* already gone */
        }
      }
      gatewayNames = [];
    };
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
      disposeGateways?.();
      disposeGateways = undefined;
      disclosure.dispose();
      ownerIndex.dispose();
    },
    "dsh-tool-gate: gateways, disclosure and attribution",
  );
}

export default { name, inject, Config, apply };
