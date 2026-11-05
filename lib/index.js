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
import { installInterception } from "./guard.js";
import { createOwnerIndex } from "./owner.js";
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

  const ownerIndex = createOwnerIndex(ctx, logger);
  const states = createStateStore();

  /** Resolved family table + resolver, rebuilt only when the configured table changes. */
  let families = resolveFamilies(currentConfig().families);
  let resolver = createFamilyResolver(families, ownerIndex.ownerOf);
  let familySignature = JSON.stringify(currentConfig().families ?? {});

  /** Keep the family table in step with live config edits. */
  const refreshFamilies = () => {
    const live = currentConfig();
    const signature = JSON.stringify(live.families ?? {});
    if (signature !== familySignature) {
      familySignature = signature;
      families = resolveFamilies(live.families);
      resolver = createFamilyResolver(families, ownerIndex.ownerOf);
    }
    return live;
  };

  const gatewayNameFor = (familyId) => gatewayName(currentConfig().gatewayPrefix, familyId);
  const labelFor = (familyId) => families[familyId]?.label || familyId;

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
  };

  // ——— gateways ————————————————————————————————————————————————————
  /** Names currently registered, and their disposer. */
  let gatewayNames = [];
  let disposeGateways = undefined;

  /**
   * Register or withdraw the gateways to match `enabled`.
   *
   * Withdrawing matters: a gateway registered while the plugin is off would put
   * eight extra tools on the wire for nothing, and `enabled: false` has to mean
   * "this plugin never touched anything".
   */
  const syncGateways = (enabled) => {
    if (enabled && disposeGateways === undefined) {
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
      return;
    }
    if (!enabled && disposeGateways !== undefined) {
      disposeGateways();
      disposeGateways = undefined;
    }
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

    const state = states.ensure(agent);
    let frozen = state.frozen;
    if (frozen === undefined || live.freeze === false) {
      const built = buildFrozenSurface(result.tools, {
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

    let sections = result.sections;
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

  // ——— teardown ————————————————————————————————————————————————————
  ctx.effect(
    () => () => {
      disposeGateways?.();
      disposeGateways = undefined;
      ownerIndex.dispose();
    },
    "dsh-tool-gate: gateways and attribution",
  );
}

export default { name, inject, Config, apply };
