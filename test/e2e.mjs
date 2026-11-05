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
// Tests live in <package>/test, so the package under test is one level up.
const PKG = path.dirname(HERE);
const at = (relative) => pathToFileURL(path.join(PKG, relative)).href;

/**
 * The renderers this plugin's behaviour is judged by, imported from the host so
 * the assertions cannot drift from what the provider actually receives.
 */
const { renderPrompt, renderContextSections, joinContextSections } = await import(
  pathToFileURL(path.join(PKG, "node_modules", "@deepseek-ai", "dsh-system-prompt", "lib", "index.js")).href
);

const { Config } = await import(at("lib/config.js"));
const plugin = await import(at("lib/index.js"));

// ————————————————————————————————————————————————————————————————
// A fake host
// ————————————————————————————————————————————————————————————————
function createHost(options = {}) {
  const listeners = new Map(); // event -> [fn]
  const tools = new Map(); // name -> definition
  const scopedTools = new Map(); // agent -> Map<name, definition>
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
    /**
     * Visible schemas for one scope.
     *
     * Mirrors the host's `view(scope)`: the global layer plus every tool the scope
     * itself registered. A hole here would hide real bugs, because a plugin that
     * registers from inside a scoped `ctx.inject` is only visible with a scope —
     * exactly how the schedule bundle registers its four tools.
     */
    schemas(scope) {
      const visible = new Map(tools);
      for (const definition of scopedTools.get(scope)?.values() ?? []) visible.set(definition.name, definition);
      return [...visible.values()].map((definition) => ({
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

  /**
   * Prompt registries, mirroring `NamedEntries`: unique names per table, insertion
   * order, and an idempotent undo. The plugin re-enters `assemble()` and also
   * inspects these tables for the settings page, so they must behave the same.
   */
  const promptSections = new Map();
  const promptContexts = new Map();
  const namedEntries = (map, label) => ({
    insert(name, value) {
      if (map.has(name)) throw new Error(`${label} "${name}" is already registered`);
      map.set(name, value);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        map.delete(name);
      };
    },
    get: (name) => map.get(name),
    has: (name) => map.has(name),
    entries: () => map.entries(),
    values: () => map.values(),
    isEmpty: () => map.size === 0,
  });
  const promptLayer = {
    sections: namedEntries(promptSections, "prompt section"),
    contexts: namedEntries(promptContexts, "prompt context"),
  };
  const systemPrompt = {
    layers: {
      global: promptLayer,
      scoped: new Map(),
      chainLayers: () => [],
      merge: (_scope, pick) => new Map(pick(promptLayer).entries()),
    },
    section(entry) {
      if (!Number.isFinite(entry?.order)) throw new TypeError(`prompt section "${entry?.name}" order must be a finite number`);
      return promptLayer.sections.insert(entry.name, entry);
    },
    context(entry) {
      if (!Number.isFinite(entry?.order)) throw new TypeError(`prompt context "${entry?.name}" order must be a finite number`);
      return promptLayer.contexts.insert(entry.name, entry);
    },
    /**
     * Re-resolve accepted contexts from their live providers, exactly like the
     * host does before building a request. This is why withholding cannot be done
     * by blanking the assembled copy alone: the provider would win.
     */
    refreshContext(assembly, context = {}) {
      const contexts = [];
      for (const accepted of assembly.contexts ?? []) {
        const provider = promptContexts.get(accepted.name);
        if (provider === undefined) {
          contexts.push(accepted);
          continue;
        }
        const text = typeof provider.text === "function" ? provider.text(context) : provider.text;
        contexts.push({ name: provider.name, text: String(text ?? "") });
      }
      return { ...assembly, contexts };
    },
  };

  const resolveService = (name) => {
    if (name === "systemPrompt") return systemPrompt;
    if (name === "agents") return { list: () => agents };
    if (name === "webServer") return options.webServer;
    return undefined;
  };

  const ctx = {
    logger,
    tools: toolsService,
    on,
    /**
     * Resolve a service through the `internal/get` waterfall, exactly like the
     * host: that event is how the plugin's live attribution observes (and wraps)
     * the instance a registrant receives.
     */
    get(name, _strict) {
      const list = [...(listeners.get("internal/get") ?? [])];
      let index = -1;
      const next = (error) => {
        index += 1;
        const fn = list[index];
        if (fn === undefined) return resolveService(name);
        return fn(ctx, name, error ?? new Error(`cannot get property "${name}" without inject`), () => next(error));
      };
      return next();
    },
    effect(fn) {
      effects.push(fn);
      const disposer = fn();
      return disposer;
    },
    /** Run a callback once the named services exist — already true in this fake. */
    inject(names, callback) {
      if (names.includes("webServer") && options.webServer === undefined) return undefined;
      return callback(ctx);
    },
    /** Number of times an assemble listener body actually ran. */
    stats: { assembles: 0 },
  };

  /**
   * Assemble with real re-entry behaviour.
   *
   * `mode` mirrors `tools.wireSchemas(scope)`: under a non-native (PTC)
   * presentation the host puts `run_code` on the wire and nothing else.
   *
   * Registered prompt sections and contexts are folded in *before* the waterfall,
   * which is what lets a listener blank them (the disclosure path) and is also
   * what makes the byte-stability assertions meaningful.
   */
  let depth = 0;
  const renderEntries = (map, context) =>
    [...map.entries()]
      .sort(([, a], [, b]) => (a.order ?? 0) - (b.order ?? 0) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map(([name, entry]) => ({
        name,
        text: typeof entry.text === "function" ? String(entry.text(context) ?? "") : String(entry.text ?? ""),
        ...(entry.interpolate !== undefined ? { interpolate: entry.interpolate } : {}),
      }));

  const assemble = async (scope, mode = "native") => {
    const collected = toolsService.schemas();
    const context = { scope };
    const base = {
      sections: [{ name: "identity", text: "you are a harness" }, ...renderEntries(promptSections, context)],
      contexts: renderEntries(promptContexts, context),
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

  return {
    ctx,
    assemble,
    isReentrant,
    tools: toolsService,
    guards,
    agents,
    loggerLines,
    effects,
    systemPrompt,
    promptSections,
    promptContexts,
    scopedTools,
  };
}

/** Register a third-party-looking tool. */
/**
 * Register a tool into one agent's scope instead of the global layer.
 *
 * Used by the scoped-visibility scenario: the schedule bundle registers from
 * inside a scoped `ctx.inject`, and a `schemas()` call without that scope must
 * not be able to see it.
 */
function addScopedTool(host, agent, name, description = `${name} does things`) {
  let layer = host.scopedTools.get(agent);
  if (layer === undefined) {
    layer = new Map();
    host.scopedTools.set(agent, layer);
  }
  layer.set(name, { name, description, parameters: { type: "object", additionalProperties: true } });
}

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

// ————————————————————————————————————————————————————————————————
// 8. Builtin families collapse, and the group switch turns them back on
// ————————————————————————————————————————————————————————————————
{
  const host = createHost();
  for (const name of ["workflow", "session_search", "session_trace", "schedule_create", "ops_bash"]) {
    addTool(host, name);
  }
  plugin.apply(host.ctx, Config({ enabled: true }));
  const agent = { id: "s8", session: { log: [] } };
  host.agents.push(agent);
  const on = await host.assemble(agent);
  const names = on.tools.map((t) => t.name);
  assert.ok(!names.includes("session_search"), "session_search collapses into its family");
  assert.ok(!names.includes("schedule_create"), "schedule_create collapses into its family");
  assert.ok(names.includes("session"), "the session gateway is on the wire");
  assert.ok(names.includes("schedule"), "the schedule gateway is on the wire");
  assert.ok(names.includes("workflow"), "an unlisted core tool still stays");

  // Listing the builtin family returns its members like any other.
  const listed = await host.ctx.tools.execute({ callId: "b1", name: "session", arguments: { action: "list" }, agent });
  assert.equal(listed.isError, false);
  const payload = JSON.parse(listed.content[0].text);
  assert.deepEqual(payload.members.map((m) => m.name), ["session_search", "session_trace"]);
  console.log("OK builtin families collapse and list");
}

// ————————————————————————————————————————————————————————————————
// 9. The builtin group switch keeps those tools resident
// ————————————————————————————————————————————————————————————————
{
  const host = createHost();
  for (const name of ["workflow", "session_search", "blender_rt_do"]) addTool(host, name);
  const live = Config({ enabled: true, builtinFamilies: false });
  plugin.apply(host.ctx, live);
  const agent = { id: "s9", session: { log: [] } };
  host.agents.push(agent);
  const on = await host.assemble(agent);
  const names = on.tools.map((t) => t.name);
  assert.ok(names.includes("session_search"), "builtinFamilies:false keeps session tools on the wire");
  assert.ok(!names.includes("blender_rt_do"), "third-party families still collapse");
  assert.equal(host.tools.get("session"), undefined, "the session gateway is not registered");

  // Flipping the group switch live restores the gateway and re-collapses.
  const write = (field, value) => {
    const ref = live[field];
    ref[Object.getOwnPropertySymbols(ref).find((s) => String(s).includes("volatile.write"))](value);
  };
  write("freeze", false);
  write("builtinFamilies", true);
  const after = await host.assemble(agent);
  assert.ok(!after.tools.map((t) => t.name).includes("session_search"), "turning the group on collapses again");
  assert.ok(host.tools.get("session") !== undefined, "the gateway came back");
  console.log("OK builtin group switch");
}

// ————————————————————————————————————————————————————————————————
// 10. Prompt disclosure: the prose never reaches the request, and stays stable
// ————————————————————————————————————————————————————————————————
{
  const host = createHost();
  for (const name of ["workflow", "generate_image", "edit_image", "free_search_test"]) addTool(host, name);
  // Two plugin-owned prompt contributions: one section (search-style) and one
  // context (image-style), both attached to a collapsed family.
  host.systemPrompt.section({ name: "free-search:engines", order: 500, text: "Current mode: auto. Enabled engines: tavily." });
  host.systemPrompt.context({ name: "dsh-image-gen:image-defaults", order: 59, text: "Image tools default provider: openai-compat." });

  const live = Config({
    enabled: true,
    promptDisclosure: true,
    promptPlugins: { "dsh-free-search": { enabled: true }, "dsh-image-gen": { enabled: true } },
  });
  plugin.apply(host.ctx, live);
  const agent = { id: "s10", session: { log: [] } };
  host.agents.push(agent);

  const first = await host.assemble(agent);
  const blank = (list) => list.filter((entry) => entry.text === "");
  assert.deepEqual(
    blank(first.sections).map((s) => s.name),
    ["free-search:engines"],
    "the search section is blanked from the very first assembly",
  );
  assert.deepEqual(
    blank(first.contexts).map((s) => s.name),
    ["dsh-image-gen:image-defaults"],
    "the image context is blanked too",
  );
  // The rendered prompt and the runtime-context message both lose the prose.
  assert.equal(renderPrompt(first).includes("Enabled engines"), false, "the section text is gone from the prompt");
  assert.equal(joinContextSections(renderContextSections(first)).includes("default provider"), false,
    "the context text is gone from the runtime-context message");

  // Byte stability: a later assembly (and a refreshContext round, which is what
  // the loop actually calls before building the request) must agree.
  const second = await host.assemble(agent);
  assert.equal(JSON.stringify(second.sections), JSON.stringify(first.sections), "sections are byte-stable");
  assert.equal(JSON.stringify(second.contexts), JSON.stringify(first.contexts), "contexts are byte-stable");
  const refreshed = host.systemPrompt.refreshContext(second, { scope: agent });
  assert.equal(
    renderContextSections(refreshed).some((entry) => entry.text.includes("default provider")),
    false,
    "refreshContext cannot bring the withheld context back",
  );

  // Required / identity / persona entries are never touched.
  host.systemPrompt.context({ name: "working-directory:current", order: 100, required: true, text: "cwd: D:/x" });
  host.systemPrompt.section({ name: "harness:identity", order: -1000, text: "You are an AI agent." });
  const third = await host.assemble(agent);
  assert.equal(
    third.contexts.find((c) => c.name === "working-directory:current").text,
    "cwd: D:/x",
    "required context is never blanked",
  );
  assert.equal(third.sections.find((s) => s.name === "harness:identity").text, "You are an AI agent.", "identity stays");

  // Turning the master switch off puts the prose back on the next assembly.
  const write = (field, value) => {
    const ref = live[field];
    ref[Object.getOwnPropertySymbols(ref).find((s) => String(s).includes("volatile.write"))](value);
  };
  write("promptDisclosure", false);
  const off = await host.assemble(agent);
  assert.equal(
    off.sections.find((s) => s.name === "free-search:engines").text,
    "Current mode: auto. Enabled engines: tavily.",
    "disabling disclosure restores the original text",
  );
  assert.equal(
    renderContextSections(host.systemPrompt.refreshContext(off, { scope: agent }))
      .find((entry) => entry.name === "dsh-image-gen:image-defaults").text,
    "Image tools default provider: openai-compat.",
    "and restores the context through refreshContext too",
  );
  console.log("OK prompt disclosure withholds the prose and survives refreshContext");
}

// ————————————————————————————————————————————————————————————————
// 11. The withheld prose is returned by action=list, exactly once
// ————————————————————————————————————————————————————————————————
{
  const host = createHost();
  for (const name of ["workflow", "generate_image", "edit_image"]) addTool(host, name);
  host.systemPrompt.context({ name: "dsh-image-gen:image-defaults", order: 59, text: "Image tools default provider: openai-compat." });

  const live = Config({
    enabled: true,
    promptDisclosure: true,
    promptPlugins: { "dsh-image-gen": { enabled: true } },
  });
  plugin.apply(host.ctx, live);
  const agent = { id: "s11", session: { log: [] } };
  host.agents.push(agent);
  await host.assemble(agent);

  const listed = await host.ctx.tools.execute({ callId: "l1", name: "image", arguments: { action: "list" }, agent });
  assert.equal(listed.isError, false);
  assert.equal(listed.content.length, 2, "list returns the members plus one prose block");
  assert.match(listed.content[1].text, /「图像」家族的使用说明/, "the prose block is labelled as family guidance");
  assert.match(listed.content[1].text, /provider: openai-compat/, "the plugin's own text is returned verbatim");

  // A second list does not repeat the prose: it is already in the history.
  const again = await host.ctx.tools.execute({ callId: "l2", name: "image", arguments: { action: "list" }, agent });
  assert.equal(again.content.length, 1, "a repeat list does not repeat the prose");
  assert.match(again.content[0].text, /已在本会话中返回过/, "a repeat list is the one-line reminder");
  console.log("OK list discloses the withheld prose exactly once");
}

// ————————————————————————————————————————————————————————————————
// 12. The settings bridge reports the live inventory
// ————————————————————————————————————————————————————————————————
{
  const routes = new Map();
  const host = createHost({
    webServer: {
      register(route) {
        routes.set(route.path, route);
        return () => routes.delete(route.path);
      },
    },
  });
  for (const name of ["workflow", "session_search", "blender_rt_do", "gh_repo"]) addTool(host, name);
  host.systemPrompt.section({ name: "free-search:engines", order: 500, text: "engines here" });

  plugin.apply(host.ctx, Config({ enabled: true }));
  const agent = { id: "s12", session: { log: [] } };
  host.agents.push(agent);
  await host.assemble(agent);

  assert.ok(routes.has("/api/dsh-tool-gate/describe"), "the describe route is registered");

  const request = {
    method: "GET",
    headers: { host: "127.0.0.1:52993" },
    socket: { remoteAddress: "127.0.0.1", localAddress: "127.0.0.1" },
  };
  let status;
  let body;
  const response = {
    writeHead(code) {
      status = code;
    },
    end(text) {
      body = JSON.parse(text);
    },
  };
  await routes.get("/api/dsh-tool-gate/describe").handler(request, response);
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  const value = body.value;
  assert.equal(value.enabled, true);
  assert.ok(value.families.length >= 10, "every family is listed");
  const session = value.families.find((family) => family.id === "session");
  assert.ok(session.count >= 1, "the session family reports its live member count");
  assert.ok(session.tokens > 0, "and a token weight");
  assert.ok(
    value.plugins.some((pluginRow) => pluginRow.package === "dsh-free-search"),
    "the injected prompt text is attributed to its plugin",
  );

  // A cross-site request must be refused.
  let deniedStatus;
  await routes.get("/api/dsh-tool-gate/describe").handler(
    { ...request, headers: { ...request.headers, "sec-fetch-site": "cross-site" } },
    { writeHead: (code) => { deniedStatus = code; }, end: () => {} },
  );
  assert.equal(deniedStatus, 403, "a cross-site request is refused");
  console.log("OK settings bridge describe");
}

// ————————————————————————————————————————————————————————————————
// 13. A tool registered inside a scoped ctx.inject is a visible member
// ————————————————————————————————————————————————————————————————
// The schedule bundle registers its four tools from inside a scoped inject, so
// they live in the agent layer rather than the global one. Anything that reads
// `tools.schemas()` without a scope sees an empty family and answers "no
// members" while the tools sit in the very same session.
{
  const host = createHost();
  addTool(host, "workflow");
  plugin.apply(host.ctx, Config({ enabled: true, builtinFamilies: true }));
  const agent = { id: "s13", session: { log: [] } };
  host.agents.push(agent);
  for (const name of ["schedule_create", "schedule_delete", "schedule_list", "schedule_update"]) {
    addScopedTool(host, agent, name);
  }
  const assembly = await host.assemble(agent);

  assert.ok(assembly.tools.some((schema) => schema.name === "schedule"), "the schedule gateway is on the wire");
  assert.ok(!assembly.tools.some((schema) => schema.name === "schedule_create"), "its members are not");

  const listed = await host.tools.execute({
    callId: "c13",
    name: "schedule",
    arguments: { action: "list" },
    agent,
    signal: undefined,
  });
  const text = listed.content.map((block) => block.text ?? "").join("\n");
  assert.match(text, /schedule_create/, "scoped members appear in the list");
  assert.match(text, /schedule_update/, "all four of them");

  // The settings inventory must agree with the gateway.
  const bridge = createHost({
    webServer: {
      register(route) {
        this.routes ??= new Map();
        this.routes.set(route.path, route);
        return () => this.routes.delete(route.path);
      },
    },
  });
  addTool(bridge, "workflow");
  plugin.apply(bridge.ctx, Config({ enabled: true, builtinFamilies: true }));
  const scopedAgent = { id: "s13b", session: { log: [] } };
  bridge.agents.push(scopedAgent);
  for (const name of ["schedule_create", "schedule_delete", "schedule_list", "schedule_update"]) {
    addScopedTool(bridge, scopedAgent, name);
  }
  await bridge.assemble(scopedAgent);
  let payload;
  const route = bridge.ctx.get("webServer", false).routes.get("/api/dsh-tool-gate/describe");
  await route.handler(
    {
      method: "GET",
      headers: { host: "127.0.0.1:52993" },
      socket: { remoteAddress: "127.0.0.1", localAddress: "127.0.0.1" },
    },
    { writeHead: () => {}, end: (body) => { payload = JSON.parse(body); } },
  );
  const schedule = payload.value.families.find((family) => family.id === "schedule");
  assert.equal(schedule.count, 4, "the settings page counts the scoped members too");
  assert.ok(schedule.tokens > 0, "and weighs them");
  console.log("OK scoped registrations are visible members");
}

console.log("\nALL END-TO-END CHECKS PASSED");
