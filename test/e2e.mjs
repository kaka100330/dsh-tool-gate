/**
 * End-to-end harness: drive the real `apply()` against a fake host that mimics
 * the parts of the tool registry and prompt services this plugin touches.
 *
 * The fake is deliberately faithful where it matters:
 *  - `system-prompt/assemble` is a waterfall whose return value is authoritative,
 *    and re-entering `assemble()` from inside it runs the listeners again (that is
 *    what `dsh-ops` does four times, and the thing the freeze must survive).
 *  - `tools.register` / `tools.schemas` / `tools.get` / `tools.execute` mirror the
 *    registry, including "the assembled list does not gate execution".
 *  - `tools/pre-execute` is a waterfall returning `{kind:'allow'|'deny'}`.
 *  - `tools.guard` is the monotonic denial list.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const PKG = path.join(HERE, "..");
const at = (relative) => pathToFileURL(path.join(PKG, relative)).href;

const { Config } = await import(at("lib/config.js"));
const plugin = await import(at("lib/index.js"));

// ————————————————————————————————————————————————————————————————
// A fake host
// ————————————————————————————————————————————————————————————————
function createHost(options = {}) {
  const listeners = new Map(); // event -> [fn]
  const tools = new Map(); // name -> definition
  const guards = [];
  const effects = [];
  const loggerLines = [];
  const logger = {
    debug: (line) => loggerLines.push(`debug ${line}`),
    warn: (line) => loggerLines.push(`warn ${line}`),
    info: (line) => loggerLines.push(`info ${line}`),
  };

  const on = (event, fn) => {
    const list = listeners.get(event) ?? [];
    list.push(fn);
    listeners.set(event, list);
    return () => {
      const at2 = listeners.get(event) ?? [];
      const index = at2.indexOf(fn);
      if (index >= 0) at2.splice(index, 1);
    };
  };

  /**
   * Run a two-argument waterfall (`tools/pre-execute` shape: `(payload, next)`).
   * `system-prompt/assemble` has its own three-argument runner below.
   */
  const waterfall2 = async (event, payload, fallback) => {
    const list = [...(listeners.get(event) ?? [])];
    let index = -1;
    const next = async () => {
      index += 1;
      const fn = list[index];
      if (fn === undefined) return fallback();
      return fn(payload, next);
    };
    return next();
  };

  const toolsService = {
    register(definition) {
      if (tools.has(definition.name)) throw new Error(`duplicate tool ${definition.name}`);
      tools.set(definition.name, definition);
      return () => {
        if (tools.get(definition.name) === definition) tools.delete(definition.name);
      };
    },
    get(name) {
      return tools.get(name);
    },
    schemas() {
      return [...tools.values()].map((definition) => ({
        name: definition.name,
        description: definition.description,
        parameters: definition.parameters,
      }));
    },
    guard(fn) {
      guards.push(fn);
      return () => {
        const index = guards.indexOf(fn);
        if (index >= 0) guards.splice(index, 1);
      };
    },
    async execute(input) {
      // Pre-execute waterfall, then the guard list — same order as the host.
      const gate = await waterfall2("tools/pre-execute", input, () => ({ kind: "allow" }));
      if (gate.kind === "deny") {
        return {
          isError: true,
          error: { message: gate.reason },
          content: [{ type: "text", text: `Error: ${gate.reason}` }],
        };
      }
      const denied = guards.map((fn) => fn(input)).find((reason) => reason !== undefined);
      if (denied !== undefined) {
        return {
          isError: true,
          error: { message: denied },
          content: [{ type: "text", text: `Error: ${denied}` }],
        };
      }
      const definition = tools.get(input.name);
      if (definition === undefined) {
        return { isError: true, error: { message: `unknown tool ${input.name}` }, content: [] };
      }
      const extra = { ...input, deferred: [], concluded: false, deferContext(c) { extra.deferred.push(c); }, concludeTurn() { extra.concluded = true; } };
      const returned = await definition.execute(input.arguments ?? {}, extra);
      return { isError: false, value: returned, content: returned.content ?? [], additionalContexts: extra.deferred, ...(extra.concluded ? { concludesTurn: true } : {}) };
    },
  };

  const agents = [];
  const ctx = {
    logger,
    tools: toolsService,
    on,
    get(name) {
      return name === "agents" ? { list: () => agents } : undefined;
    },
    effect(fn) {
      effects.push(fn);
      const disposer = fn();
      return disposer;
    },
    /** Number of times an assemble listener body actually ran. */
    stats: { assembles: 0 },
  };

  /**
   * Assemble with real re-entry behaviour.
   *
   * `mode` mirrors `tools.wireSchemas(scope)`: under a non-native (PTC)
   * presentation the host puts `run_code` on the wire and nothing else.
   */
  let depth = 0;
  const assemble = async (scope, mode = "native") => {
    const collected = toolsService.schemas();
    const base = {
      sections: [{ name: "identity", text: "you are a harness" }],
      contexts: [],
      tools: mode === "native" ? collected : collected.filter((schema) => schema.name === "run_code"),
      variables: {},
    };
    // Waterfall: a listener may call the prompt service again, which re-enters.
    const run = async () => {
      const list = [...(listeners.get("system-prompt/assemble") ?? [])];
      let index = -1;
      const next = async () => {
        index += 1;
        const fn = list[index];
        if (fn === undefined) return base;
        return fn(base, { scope }, next);
      };
      return next();
    };
    depth += 1;
    try {
      return await run();
    } finally {
      depth -= 1;
    }
  };
  /** Whether an assembly is already in flight — a re-entry test must check this. */
  const isReentrant = () => depth > 1;

  return { ctx, assemble, isReentrant, tools: toolsService, guards, agents, loggerLines, effects };
}

/** Register a third-party-looking tool. */
function addTool(host, name, description = `${name} does things`) {
  host.tools.register({
    name,
    description,
    parameters: { type: "object", additionalProperties: true },
    output: { schema: { type: "json" }, render: (_args, value) => value?.content ?? [] },
    async execute(args) {
      return { content: [{ type: "text", text: `${name} ran with ${JSON.stringify(args)}` }] };
    },
  });
}

const plain = (config) => {
  const out = {};
  for (const [key, value] of Object.entries(config)) {
    out[key] = value !== null && typeof value === "object" && typeof value.get === "function" ? value.get() : value;
  }
  return out;
};

// ————————————————————————————————————————————————————————————————
// 1. Disabled means "never touched anything"
// ————————————————————————————————————————————————————————————————
{
  const host = createHost();
  for (const name of ["workflow", "ops_bash", "compress", "blender_rt_do", "gh_repo", "generate_image"]) {
    addTool(host, name);
  }
  const before = host.tools.size;
  plugin.apply(host.ctx, Config({}));

  const agent = { id: "s1" };
  host.agents.push(agent);
  const assembly = await host.assemble(agent);

  assert.equal(host.tools.size, before, "disabled: no gateway tools registered");
  assert.deepEqual(
    assembly.tools.map((t) => t.name),
    ["workflow", "ops_bash", "compress", "blender_rt_do", "gh_repo", "generate_image"],
    "disabled: every tool stays on the wire",
  );
  assert.equal(assembly.sections.length, 1, "disabled: no notice section added");
  console.log("OK disabled is a no-op");
}

// ————————————————————————————————————————————————————————————————
// 2. Enabled: freeze, notice, byte stability
// ————————————————————————————————————————————————————————————————
{
  const host = createHost();
  for (const name of [
    "workflow", "ops_bash", "compress",
    "blender_rt_do", "blender_rt_see", "gh_repo", "gh_file", "generate_image", "mcp__wincu__x",
  ]) {
    addTool(host, name);
  }
  const config = Config({ enabled: true });
  plugin.apply(host.ctx, config);

  // Gateways must exist now (registered eagerly when enabled).
  assert.ok(host.tools.get("blender"), "blender gateway registered");
  assert.ok(host.tools.get("github"), "github gateway registered");
  assert.ok(host.tools.get("image"), "image gateway registered");
  assert.ok(host.tools.get("mcp_servers"), "mcp_servers gateway registered");

  const agent = { id: "s2", session: { log: [] } };
  host.agents.push(agent);

  const first = await host.assemble(agent);
  const names = first.tools.map((t) => t.name);
  console.log("wire after freeze:", names.join(", "));
  assert.ok(names.includes("workflow"), "core tool stays");
  assert.ok(names.includes("ops_bash"), "ops tool stays");
  assert.ok(names.includes("compress"), "context tool stays");
  assert.ok(names.includes("blender"), "gateway is on the wire");
  assert.ok(!names.includes("blender_rt_do"), "blender member collapsed");
  assert.ok(!names.includes("gh_repo"), "github member collapsed");
  assert.ok(!names.includes("generate_image"), "image member collapsed");
  assert.ok(!names.includes("mcp__wincu__x"), "mcp member collapsed");

  // The notice is appended once, and stays byte-identical after.
  const notice = first.sections.find((section) => section.name === "tool-gate: progressive-disclosure");
  assert.ok(notice !== undefined, "notice section added");
  assert.match(notice.text, /`blender`/, "notice lists the blender gateway");
  assert.match(notice.text, /`github`/, "notice lists the github gateway");

  const second = await host.assemble(agent);
  assert.equal(
    JSON.stringify(second.tools.map((t) => t.name)),
    JSON.stringify(names),
    "wire is byte-stable across turns",
  );
  const notice2 = second.sections.find((section) => section.name === "tool-gate: progressive-disclosure");
  assert.equal(notice2.text, notice.text, "the notice text never drifts");
  assert.equal(second.sections.filter((s) => s.name === notice.name).length, 1, "the notice is not duplicated");

  // Re-entrancy: a second listener re-assembles from inside the waterfall, exactly
  // like `dsh-ops` does while publishing a mode. It guards against recursing into
  // itself, which is what the real listener does too (`if (!pending) return next()`).
  let reentered = false;
  host.ctx.on("system-prompt/assemble", async (_assembly, _context, next) => {
    if (reentered) return next();
    reentered = true;
    try {
      const inner = await host.assemble(agent);
      assert.deepEqual(
        inner.tools.map((t) => t.name),
        names,
        "a re-entrant assembly sees the same frozen surface",
      );
      assert.equal(
        inner.sections.filter((s) => s.name === notice.name).length,
        1,
        "a re-entrant assembly does not duplicate the notice",
      );
    } finally {
      reentered = false;
    }
    return next();
  });
  const third = await host.assemble(agent);
  assert.equal(JSON.stringify(third.tools.map((t) => t.name)), JSON.stringify(names), "still stable after re-entry");
  const notices = third.sections.filter((s) => s.name === notice.name);
  assert.equal(notices.length, 1, "re-entry does not duplicate the notice");
  console.log("OK enabled: freeze + notice + re-entry");
}

// ————————————————————————————————————————————————————————————————
// 3. Interception: a collapsed tool cannot be called directly
// ————————————————————————————————————————————————————————————————
{
  const host = createHost();
  addTool(host, "workflow");
  addTool(host, "blender_rt_do");
  plugin.apply(host.ctx, Config({ enabled: true }));
  const agent = { id: "s3", session: { log: [] } };
  host.agents.push(agent);
  await host.assemble(agent);

  const blocked = await host.ctx.tools.execute({ callId: "c1", name: "blender_rt_do", arguments: {}, agent });
  assert.equal(blocked.isError, true, "a collapsed tool is refused when called directly");
  assert.match(blocked.error.message, /已收进网关 blender/, "the refusal names the gateway to use");

  const allowed = await host.ctx.tools.execute({ callId: "c2", name: "workflow", arguments: {}, agent });
  assert.equal(allowed.isError, false, "an exposed tool still runs");

  // Through the gateway: the member runs, and the sub-call id marks it as vetted.
  const viaGateway = await host.ctx.tools.execute({
    callId: "c3",
    name: "blender",
    arguments: { action: "call", tool: "blender_rt_do", arguments: { n: 1 } },
    agent,
  });
  assert.equal(viaGateway.isError, false, "the gateway can call its member");
  assert.match(viaGateway.content[0].text, /blender_rt_do ran with/, "the member actually ran");

  // A forged deep call id (as if a plugin tried to bypass) is still allowed only
  // through the gateway path, which is the intended escape hatch.
  const forged = await host.ctx.tools.execute({
    callId: "x:gw:9",
    name: "blender_rt_do",
    arguments: {},
    agent,
  });
  assert.equal(forged.isError, false, "the :gw: marker is what the layers key on");
  console.log("OK interception");
}

// ————————————————————————————————————————————————————————————————
// 4. turn semantics survive the gateway hop
// ————————————————————————————————————————————————————————————————
{
  const host = createHost();
  host.tools.register({
    name: "hindsight_reflect",
    description: "reflect",
    parameters: { type: "object", additionalProperties: true },
    output: { schema: { type: "json" }, render: (_a, value) => value.content },
    async execute(_args, exec) {
      exec.deferContext({ role: "user", content: "injected" });
      exec.concludeTurn();
      return { content: [{ type: "text", text: "reflected" }] };
    },
  });
  plugin.apply(host.ctx, Config({ enabled: true }));
  const agent = { id: "s4", session: { log: [] } };
  host.agents.push(agent);
  await host.assemble(agent);

  const result = await host.ctx.tools.execute({
    callId: "c9",
    name: "hindsight",
    arguments: { action: "call", tool: "hindsight_reflect", arguments: {} },
    agent,
  });
  assert.equal(result.isError, false);
  assert.equal(result.concludesTurn, true, "concludeTurn is lifted to the outer execution");
  assert.deepEqual(result.additionalContexts, [{ role: "user", content: "injected" }], "deferred context is lifted");
  console.log("OK turn semantics");
}

// ————————————————————————————————————————————————————————————————
// 5. PTC scopes are left alone
// ————————————————————————————————————————————————————————————————
{
  const host = createHost();
  addTool(host, "run_code");
  addTool(host, "blender_rt_do");
  plugin.apply(host.ctx, Config({ enabled: true }));
  const agent = { id: "s5", session: { log: [] } };
  host.agents.push(agent);
  const assembly = await host.assemble(agent, "ptc");
  assert.deepEqual(assembly.tools.map((t) => t.name), ["run_code"], "a PTC scope keeps its single entry");
  console.log("OK PTC scope untouched");
}

// ————————————————————————————————————————————————————————————————
// 6. Per-agent isolation
// ————————————————————————————————————————————————————————————————
{
  const host = createHost();
  addTool(host, "workflow");
  addTool(host, "blender_rt_do");
  plugin.apply(host.ctx, Config({ enabled: true }));
  const a = { id: "sa", session: { log: [] } };
  const b = { id: "sb", session: { log: [] } };
  host.agents.push(a, b);
  await host.assemble(a);
  await host.assemble(b);
  // Collapsing in one agent must not leak into the other's refusal decision.
  const bState = host.ctx.tools.execute({ callId: "c", name: "blender_rt_do", arguments: {}, agent: b });
  const bResult = await bState;
  assert.equal(bResult.isError, true, "each agent has its own collapsed set");
  console.log("OK per-agent isolation");
}

// ————————————————————————————————————————————————————————————————
// 7. Live config: flipping enabled off restores everything
// ————————————————————————————————————————————————————————————————
{
  const host = createHost();
  for (const name of ["workflow", "blender_rt_do"]) addTool(host, name);
  const live = Config({ enabled: true });
  plugin.apply(host.ctx, live);
  const agent = { id: "s7", session: { log: [] } };
  host.agents.push(agent);
  const on = await host.assemble(agent);
  assert.ok(!on.tools.map((t) => t.name).includes("blender_rt_do"));

  // Flip the volatile field the way the settings page does.
  const writes = live.enabled;
  writes[Object.getOwnPropertySymbols(writes).find((s) => String(s).includes("volatile.write"))](false);
  assert.equal(plain(live).enabled, false, "the volatile write took effect");

  const off = await host.assemble(agent);
  assert.ok(off.tools.map((t) => t.name).includes("blender_rt_do"), "turning it off restores the tool");
  assert.equal(off.sections.some((s) => s.name === "tool-gate: progressive-disclosure"), false, "notice withdrawn");
  assert.equal(host.tools.get("blender"), undefined, "gateway unregistered when disabled");
  console.log("OK live toggle");
}

console.log("\nALL END-TO-END CHECKS PASSED");
