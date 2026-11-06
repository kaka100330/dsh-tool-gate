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

/**
 * Parameter spec shared verbatim by every gateway (M7: no member enum — that
 * would move the schema).
 *
 * These three descriptions are paid once per gateway, so on a profile with a
 * dozen families they are repeated a dozen times. Short is the point: the model
 * has to know how to call a gateway, not why gateways exist — that is the
 * system-prompt notice's job. Anything that belongs to one member tool belongs to
 * that tool's own schema, which `list` returns.
 */
const GATEWAY_PARAMETERS = {
  action: {
    type: "string",
    required: true,
    enum: ["list", "call"],
    description: "list 取回该家族全部成员的定义；call 调用其中一个成员",
  },
  tool: {
    type: "string",
    description: "action=call 时的成员工具名（先 list）",
  },
  arguments: {
    type: "object",
    additionalProperties: true,
    description: "action=call 时传给成员的实参对象",
  },
};

/**
 * What this family is for, and nothing else.
 *
 * The usage contract — what `list` and `call` do, that a second `list` answers in
 * one line, that a direct call is refused — lives in the system-prompt notice
 * (`buildNotice` in `index.js`) instead. It used to be repeated here, once per
 * gateway: 351 bytes × 12 gateways in the measured profile, 85% of all gateway
 * description text, identical every time. Saying the same thing on every gateway
 * is exactly the redundancy that notice exists to remove.
 *
 * `selfExplaining` covers the one configuration where the notice is not there
 * (`staticNotice: false`): then this line is the model's only hint that the tool
 * is a gateway at all, so it carries the minimum needed to use it.
 *
 * Member counts are deliberately absent — they change, and this text must not.
 */
function describeGateway(family, options) {
  const label = family.label || family.id;
  const detail = family.description || "";
  const head = detail === "" ? `网关 · ${label}` : `网关 · ${label}：${detail}`;
  return options?.selfExplaining === true
    ? `${head}\n用 action="list" 查看成员，action="call" + tool + arguments 调用。`
    : head;
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
  // Read the switch once here; `runtime.config()` is a live reader that also
  // rebuilds the family table, so calling it per gateway is not free.
  const selfExplaining = options.selfExplaining ?? runtime.config().staticNotice === false;
  return defineTool({
    name,
    description: describeGateway(family, { selfExplaining }),
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
  const selfExplaining = runtime.config().staticNotice === false;

  for (const family of Object.values(families)) {
    if (family.enabled === false) continue;
    const name = gatewayNameFor(family.id);
    try {
      const definition = createGateway({ family, name, runtime, selfExplaining });
      disposers.push(ctx.tools.register(definition));
      names.push(name);
    } catch (error) {
      logger?.warn?.(`dsh-tool-gate: could not register gateway "${name}": ${String(error?.message ?? error)}`);
    }
  }
  return { disposers, names };
}

/**
 * The bytes a gateway's own registration depends on.
 *
 * A gateway is only re-registered when this changes. Names alone are not enough:
 * a plugin upgrade rewrites a family's description, and `staticNotice` flipping
 * changes whether the description has to explain itself — both are wire bytes,
 * and leaving the old registration in place after either would show the model
 * stale text for the rest of the session.
 */
function signatureOf(family, selfExplaining) {
  return JSON.stringify([family.id, family.label ?? "", family.description ?? "", selfExplaining]);
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
 * Here a gateway is only touched when its own name appears, disappears, or its
 * own description bytes change.
 *
 * @param options.ctx - plugin context.
 * @param options.families - desired family table.
 * @param options.gatewayNameFor - `(familyId) => wire name`.
 * @param options.runtime - plugin runtime.
 * @param options.logger - plugin logger.
 * @param options.mounted - `Map<name, { familyId, signature, dispose }>` of what
 *   is live; updated in place.
 * @param options.unscannable - `Set<string>` kept in step with the live names.
 * @returns the live names, sorted.
 */
export function reconcileGateways(options) {
  const { ctx, families, gatewayNameFor, runtime, logger, mounted, unscannable } = options;
  // One read for the whole reconcile: `runtime.config()` rebuilds the family
  // table when its signature moved, so it must not run once per family.
  const selfExplaining = options.selfExplaining ?? runtime.config().staticNotice === false;
  const desired = new Map();
  for (const family of Object.values(families)) {
    if (family.enabled === false) continue;
    // A family with no members has nothing to disclose and nothing to route to.
    // Registering its gateway would put a tool on the wire that can only ever
    // answer "no members" — and, because gateway names are unresolvable, feed a
    // name that no bundle's source contains. `emptyFamilies` is supplied by the
    // caller, which can see the registry; this function cannot.
    if (options.emptyFamilies?.has(family.id) === true) continue;
    desired.set(gatewayNameFor(family.id), { family, signature: signatureOf(family, selfExplaining) });
  }

  for (const [name, entry] of [...mounted]) {
    const wanted = desired.get(name);
    if (wanted !== undefined && wanted.signature === entry.signature) continue;
    try {
      entry.dispose();
    } catch {
      /* already gone */
    }
    mounted.delete(name);
    unscannable?.delete(name);
  }

  for (const [name, { family, signature }] of desired) {
    if (mounted.has(name)) continue;
    try {
      const definition = createGateway({ family, name, runtime, selfExplaining });
      const dispose = ctx.tools.register(definition);
      mounted.set(name, { familyId: family.id, signature, dispose });
      unscannable?.add(name);
    } catch (error) {
      logger?.warn?.(`dsh-tool-gate: could not register gateway "${name}": ${String(error?.message ?? error)}`);
    }
  }

  return [...mounted.keys()].sort();
}
