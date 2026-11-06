/**
 * The eight gateway tools.
 *
 * Each gateway is one wire tool with a fixed three-parameter schema, so adding or
 * removing family members never changes the wire bytes. Members are looked up in
 * the live registry at call time — a tool registered after the session started is
 * callable through the gateway even though it never appears on the wire.
 */

import { defineTool } from "@deepseek-ai/dsh-tools";

import { dispatchCall, dispatchList } from "./dispatch.js";

/** Parameter spec shared verbatim by every gateway (M7: no member enum — that would move the schema). */
const GATEWAY_PARAMETERS = {
  action: {
    type: "string",
    required: true,
    enum: ["list", "call"],
    description:
      "list = 取回该家族全部工具的完整定义（名字/说明/参数）；call = 调用其中某个工具",
  },
  tool: {
    type: "string",
    description: "action=call 时必填：成员工具的唯一名字（先 action=list 查看成员）",
  },
  arguments: {
    type: "object",
    additionalProperties: true,
    description: "action=call 时传给成员工具的形参对象，必须与成员定义一致",
  },
};

/** Static description text: member counts are deliberately absent because they change. */
function describeGateway(family) {
  const label = family.label || family.id;
  const detail = family.description || "";
  return [
    `${label} 家族的网关。${detail}`,
    "这个家族的成员工具不在本轮工具列表里，全部通过本网关访问：",
    "1) action=list → 返回成员工具的名字、说明与完整参数定义；",
    "2) action=call + tool + arguments → 调用指定成员，返回值与直接调用一致。",
    "同一会话内第二次 list 同一家族只回一句提示（定义已在历史里）。",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/**
 * Create one gateway tool definition.
 *
 * @param options.family - resolved family record (`id`, `label`, `description`).
 * @param options.name - wire tool name (`gatewayPrefix` + family id).
 * @param options.runtime - `{ ctx, config, stateFor, familyOf, logger }`.
 * @returns a registry-ready `ToolDefinition`.
 */
export function createGateway(options) {
  const { family, name, runtime } = options;
  return defineTool({
    name,
    description: describeGateway(family),
    parameters: GATEWAY_PARAMETERS,
    output: {
      // A gateway's value is a projection of the member's own result, so it is
      // any JSON value shaped like `{ content: ContentBlock[] }`.
      schema: { type: "json" },
      render(_args, value) {
        return Array.isArray(value?.content) ? value.content : [];
      },
    },
    async isConcurrencySafe(args, exec) {
      const config = runtime.config();
      if (!config.concurrencyDelegate) return false;
      if (args?.action !== "call" || typeof args.tool !== "string") return false;
      // Resolve the member through the *calling agent's* scope. A scope-blind
      // `tools.get(name)` reads only the global layer, so a member registered
      // inside a scoped `ctx.inject` (the schedule bundle does exactly that)
      // reads as absent and the call is silently serialized — the delegation
      // quietly stops working for precisely the families that need it.
      const agent = exec?.agent ?? runtime.primaryAgent?.();
      let definition;
      try {
        definition = runtime.ctx.tools?.get?.(args.tool, agent);
      } catch {
        definition = undefined;
      }
      if (definition === undefined || typeof definition.isConcurrencySafe !== "function") return false;
      try {
        return definition.isConcurrencySafe(args.arguments ?? {}) === true;
      } catch {
        return false;
      }
    },
    async execute(args, exec) {
      const state = runtime.stateFor(exec.agent);
      if (args.action === "list") return dispatchList(family.id, exec, state, runtime);
      return dispatchCall(family.id, name, args, exec, state, runtime);
    },
  });
}

/**
 * Register every enabled family's gateway.
 *
 * @returns disposers plus the registered names.
 */
export function registerGateways(options) {
  const { ctx, families, gatewayNameFor, runtime, logger } = options;
  const disposers = [];
  const names = [];

  for (const family of Object.values(families)) {
    if (family.enabled === false) continue;
    const name = gatewayNameFor(family.id);
    try {
      const definition = createGateway({ family, name, runtime });
      disposers.push(ctx.tools.register(definition));
      names.push(name);
    } catch (error) {
      logger?.warn?.(`dsh-tool-gate: could not register gateway "${name}": ${String(error?.message ?? error)}`);
    }
  }
  return { disposers, names };
}

/**
 * Reconcile the mounted gateways with the desired family set.
 *
 * The previous approach disposed every gateway and re-registered the whole batch
 * whenever *anything* moved (one family switched off, one plugin installed).
 * Each of those disposals and registrations is a registry mutation, and the
 * registry is what the assembly is built from — so a single toggle produced a
 * window in which some gateways were absent, and the `pending` splice in the
 * assemble hook had to compensate for it.
 *
 * Here a gateway is only touched when its own name appears or disappears.
 *
 * @param options.ctx - plugin context.
 * @param options.families - desired family table.
 * @param options.gatewayNameFor - `(familyId) => wire name`.
 * @param options.runtime - plugin runtime.
 * @param options.logger - plugin logger.
 * @param options.mounted - `Map<name, { familyId, dispose }>` of what is live;
 *   updated in place.
 * @param options.unscannable - `Set<string>` kept in step with the live names.
 * @returns the live names, sorted.
 */
export function reconcileGateways(options) {
  const { ctx, families, gatewayNameFor, runtime, logger, mounted, unscannable } = options;
  const desired = new Map();
  for (const family of Object.values(families)) {
    if (family.enabled === false) continue;
    // A family with no members has nothing to disclose and nothing to route to.
    // Registering its gateway would put a tool on the wire that can only ever
    // answer "no members" — and, because gateway names are unresolvable, feed a
    // name that no bundle's source contains. `emptyFamilies` is supplied by the
    // caller, which can see the registry; this function cannot.
    if (options.emptyFamilies?.has(family.id) === true) continue;
    desired.set(gatewayNameFor(family.id), family);
  }

  for (const [name, entry] of [...mounted]) {
    if (desired.has(name)) continue;
    try {
      entry.dispose();
    } catch {
      /* already gone */
    }
    mounted.delete(name);
    unscannable?.delete(name);
  }

  for (const [name, family] of desired) {
    if (mounted.has(name)) continue;
    try {
      const definition = createGateway({ family, name, runtime });
      const dispose = ctx.tools.register(definition);
      mounted.set(name, { familyId: family.id, dispose });
      unscannable?.add(name);
    } catch (error) {
      logger?.warn?.(`dsh-tool-gate: could not register gateway "${name}": ${String(error?.message ?? error)}`);
    }
  }

  return [...mounted.keys()].sort();
}
