/**
 * `list` / `call` semantics for one gateway.
 *
 * Both read the live registry, not the frozen wire surface — that is what makes a
 * tool registered mid-session callable through the gateway without ever entering
 * the wire bytes.
 */

import { writeDispatchRecord } from "./state.js";

/** Compose one text content block. */
function text(value) {
  return { type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) };
}

/**
 * Render one withheld prompt contribution for disclosure.
 *
 * The heading says where the text comes from, so the model reads it as usage
 * guidance for the family it just listed rather than as a new instruction from
 * the user. The body is the plugin's own prose, verbatim.
 */
function promptBlock(familyId, label, row) {
  const source = typeof row?.name === "string" && row.name !== "" ? `（来源：${row.name}）` : "";
  return `### 「${label}」家族的使用说明${source}\n\n${String(row?.text ?? "")}`;
}

/** One member's model-facing projection: the exact wire shape the provider would have received. */
function schemaOf(schema, detailed) {
  if (!detailed) return { name: schema.name, description: schema.description };
  return { name: schema.name, description: schema.description, parameters: schema.parameters };
}

/**
 * A family's members as *this agent* can see them.
 *
 * The scope argument is not optional decoration: `tools.schemas()` with no
 * argument returns the global view only, so a tool that a plugin registered from
 * inside a scoped `ctx.inject` (the schedule bundle does this) is invisible. That
 * turns into a silent zero-member family — the gateway would answer "no members"
 * while the tools are right there in the same session.
 *
 * @param familyId - the family to collect.
 * @param runtime - the plugin runtime.
 * @param agent - the calling agent, whose scope decides visibility.
 * @returns matching schemas, sorted by name.
 */
function membersOf(familyId, runtime, agent) {
  const { ctx, familyOf } = runtime;
  let schemas = [];
  try {
    schemas = typeof ctx.tools?.schemas === "function" ? ctx.tools.schemas(agent) : [];
  } catch {
    // An agent-less query is still better than none for a diagnostic caller.
    schemas = typeof ctx.tools?.schemas === "function" ? ctx.tools.schemas() : [];
  }
  const out = [];
  for (const schema of schemas) {
    if (typeof schema?.name !== "string") continue;
    if (familyOf(schema.name) === familyId) out.push(schema);
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

/**
 * `action=list`.
 *
 * Returns every member's full definition the first time, and a one-line reminder
 * afterwards — the definitions are already in the conversation history by then,
 * and repeating them would cost the tokens this plugin exists to save.
 *
 * When prompt disclosure is on, the family's withheld plugin prose is appended
 * here: this is the one moment the model needs it, and it arrives as tool output
 * (an append) instead of as a change to the cached prefix.
 */
export function dispatchList(familyId, exec, state, runtime) {
  const { config, logger } = runtime;
  const current = config();
  // Read the resolved table, not the raw config dict: defaults live in
  // `families.js`, and a family the user never overrode is absent from config.
  const family = runtime.families?.()[familyId] ?? current.families?.[familyId];
  const label = family?.label || familyId;

  /** The withheld prompt contributions for this family, disclosed at most once. */
  const disclosure = () => {
    if (state === undefined) return [];
    const rows = state.promptText?.[familyId];
    if (!Array.isArray(rows) || rows.length === 0) return [];
    if (state.promptDisclosed?.has(familyId) === true) return [];
    state.promptDisclosed?.add(familyId);
    return rows;
  };

  if (state !== undefined && state.listed.has(familyId)) {
    const withheld = disclosure();
    return {
      content: [
        text(
          `已在本会话中返回过「${label}」家族的全部成员定义（见上文 action=list 的返回）。`
            + `直接 action=call 传 tool + arguments 即可；若需刷新成员列表可重试（成员可能在会话中有变化）。`,
        ),
        ...withheld.map((row) => text(promptBlock(familyId, label, row))),
      ],
    };
  }

  const members = membersOf(familyId, runtime, exec.agent);
  if (state !== undefined) state.listed.add(familyId);
  logger?.debug?.(`dsh-tool-gate: list ${familyId} → ${members.length} member(s)`);

  if (members.length === 0) {
    const withheld = disclosure();
    return {
      content: [
        text(
          `「${label}」家族当前没有可用的成员工具（对应插件可能未启用，或尚未注册任何工具）。`,
        ),
        ...withheld.map((row) => text(promptBlock(familyId, label, row))),
      ],
    };
  }

  const detailed = current.listDetail !== false;
  const payload = {
    family: familyId,
    label,
    count: members.length,
    members: members.map((schema) => schemaOf(schema, detailed)),
    ...(detailed
      ? {}
      : { note: "listDetail 已关闭，仅返回名字与一句话说明；调用前请按需传参数，参数不匹配会返回参数错误。" }),
  };
  const withheld = disclosure();
  return {
    content: [
      text(payload),
      ...withheld.map((row) => text(promptBlock(familyId, label, row))),
    ],
  };
}

/**
 * `action=call`.
 *
 * Dispatches the member through the registry exactly as the model would have
 * called it directly, then lifts the semantics the gateway would otherwise
 * swallow: deferred context and turn conclusion (M2).
 */
export async function dispatchCall(familyId, gatewayToolName, args, exec, state, runtime) {
  const { ctx, familyOf, logger, config } = runtime;
  const current = config();
  // Read the resolved table, not the raw config dict: defaults live in
  // `families.js`, and a family the user never overrode is absent from config.
  const family = runtime.families?.()[familyId] ?? current.families?.[familyId];
  const label = family?.label || familyId;
  const tool = args?.tool;

  if (typeof tool !== "string" || tool === "") {
    return {
      content: [text(`action=call 需要 tool 参数：${gatewayToolName} 家族的成员工具名（先 action=list 查看）。`)],
    };
  }
  const inner = args.arguments;
  if (inner !== undefined && (typeof inner !== "object" || inner === null || Array.isArray(inner))) {
    return { content: [text("arguments 必须是对象（传给成员工具的形参对象）。")] };
  }

  const definition = typeof ctx.tools?.get === "function" ? ctx.tools.get(tool, exec.agent) : undefined;
  if (definition === undefined) {
    return {
      content: [
        text(`未知工具或已于本次会话注销：${tool}。可先用 action=list 确认「${label}」家族的当前成员。`),
      ],
    };
  }
  const actualFamily = familyOf(tool);
  if (actualFamily !== familyId) {
    return {
      content: [
        text(
          actualFamily === undefined
            ? `${tool} 不属于任何网关家族，请直接调用它（它在工具列表里）。`
            : `${tool} 属于「${runtime.families?.()[actualFamily]?.label || actualFamily}」家族，请改用对应的网关工具。`,
        ),
      ],
    };
  }

  const callId = state !== undefined ? state.nextCallId(String(exec.callId ?? gatewayToolName)) : `${exec.callId}:gw:1`;
  const startedAt = Date.now();
  let result;
  try {
    result = await ctx.tools.execute({
      callId,
      rootCallId: exec.rootCallId ?? exec.callId,
      name: tool,
      arguments: inner ?? {},
      agent: exec.agent,
      signal: exec.signal,
      // `parent` is deliberately omitted: passing it would mark the member call as a
      // transport sub-dispatch, which collapses content finalizers and skips several
      // third-party presentation hooks that key off a top-level call.
    });
  } catch (error) {
    logger?.debug?.(`dsh-tool-gate: ${familyId}.${tool} threw (${String(error?.message ?? error)})`);
    writeDispatchRecord(
      exec.agent?.session,
      { gateway: gatewayToolName, tool, ok: false, ms: Date.now() - startedAt },
      logger,
    );
    throw error;
  }

  writeDispatchRecord(
    exec.agent?.session,
    { gateway: gatewayToolName, tool, ok: !result.isError, ms: Date.now() - startedAt },
    logger,
  );

  // Lift the semantics the gateway would otherwise drop on the floor.
  for (const context of result.additionalContexts ?? []) {
    try {
      exec.deferContext(context);
    } catch (error) {
      logger?.debug?.(`dsh-tool-gate: deferContext failed (${String(error?.message ?? error)})`);
    }
  }
  if (result.concludesTurn === true) {
    try {
      exec.concludeTurn();
    } catch (error) {
      logger?.debug?.(`dsh-tool-gate: concludeTurn failed (${String(error?.message ?? error)})`);
    }
  }

  if (result.isError) {
    const reason = result.error?.message ?? "member tool failed";
    // Keep the member's own prose when it wrote some: models act on the text, not on the code.
    const prose = (Array.isArray(result.content) ? result.content : [])
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("\n")
      .trim();
    const error = new Error(
      prose !== "" && !prose.includes(reason) ? `${tool} 执行失败：${reason}\n${prose}` : `${tool} 执行失败：${reason}`,
    );
    error.toolGateMember = tool;
    throw error;
  }

  return {
    content: Array.isArray(result.content) ? result.content : [],
    ...(result.meta !== undefined ? { meta: result.meta } : {}),
  };
}
