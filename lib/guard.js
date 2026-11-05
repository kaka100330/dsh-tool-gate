/**
 * Interception: make sure a collapsed tool is only reachable through its gateway.
 *
 * Two independent layers, because each covers a hole the other one leaves:
 *
 *  `tools/pre-execute` — runs inside the dispatch waterfall. It can deny with an
 *      explanation the model will read, which is what actually teaches it to use
 *      the gateway. It is switchable (`interceptDirectCalls`).
 *
 *  `tools.guard` — the registry's monotonic denial hook. It sits below every
 *      waterfall re-entry, so a listener that re-dispatches a name still gets
 *      stopped. Registered once with `notify: false` so it never changes the tool
 *      surface (a guard that moved bytes would defeat the whole plugin).
 *
 * Both stay out of the way for:
 *  - our own gateway sub-calls (`callId` carries the `:gw:` segment),
 *  - names the current agent did not actually have collapsed,
 *  - everything, while `enabled` is off.
 */

/** Marker segment the gateway puts in every sub-call id. */
const GATEWAY_CALL_SEGMENT = ":gw:";

/** Whether this execution is a gateway sub-call (and therefore already vetted). */
function isGatewaySubCall(exec) {
  const callId = exec?.callId;
  if (typeof callId !== "string") return false;
  if (callId.includes(GATEWAY_CALL_SEGMENT)) return true;
  const root = exec?.rootCallId;
  return typeof root === "string" && root.includes(GATEWAY_CALL_SEGMENT);
}

/** The denial prose, or undefined when the call is allowed. */
function denialFor(exec, runtime) {
  if (isGatewaySubCall(exec)) return undefined;
  const name = exec?.name;
  if (typeof name !== "string" || name === "") return undefined;
  const state = runtime.stateFor(exec?.agent);
  if (state === undefined || !state.collapsedNames.has(name)) return undefined;
  const family = runtime.familyOf(name);
  const gateway = family === undefined ? undefined : runtime.gatewayNameFor(family);
  if (gateway === undefined) return undefined;
  return `工具 "${name}" 不在本轮工具列表里：它属于「${runtime.labelFor(family)}」家族，已收进网关 ${gateway}。`
    + `请改为调用 ${gateway}，参数 action:"list" 先取成员定义，然后 action:"call" + tool:"${name}" + arguments:{…}。`
    + "（本提示是自动拦截，不是工具本身的错误。）";
}

/**
 * Install both interception layers.
 *
 * @param options.ctx - this plugin's context.
 * @param options.runtime - `{ config, stateFor, familyOf, gatewayNameFor, labelFor, logger }`.
 * @returns disposers.
 */
export function installInterception(options) {
  const { ctx, runtime, logger } = options;
  const disposers = [];

  if (typeof ctx.on === "function") {
    disposers.push(
      ctx.on("tools/pre-execute", (exec, next) => {
        const current = runtime.config();
        if (current.enabled !== true || current.interceptDirectCalls !== true) return next();
        let reason;
        try {
          reason = denialFor(exec, runtime);
        } catch (error) {
          logger?.debug?.(`dsh-tool-gate: pre-execute check failed (${String(error?.message ?? error)})`);
          return next();
        }
        if (reason === undefined) return next();
        return {
          kind: "deny",
          reason,
          info: { name: "ToolGateCollapsed", code: "TOOL_GATE_COLLAPSED" },
        };
      }),
    );
  }

  if (typeof ctx.tools?.guard === "function") {
    try {
      disposers.push(
        ctx.tools.guard((exec) => {
          const current = runtime.config();
          if (current.enabled !== true || current.guardFallback !== true) return undefined;
          try {
            return denialFor(exec, runtime);
          } catch {
            return undefined;
          }
        }),
      );
    } catch (error) {
      logger?.warn?.(`dsh-tool-gate: could not install tools.guard (${String(error?.message ?? error)})`);
    }
  }

  return () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose();
      } catch {
        /* already gone */
      }
    }
  };
}
