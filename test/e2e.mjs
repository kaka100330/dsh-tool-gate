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
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { forgetScanCache } from "../lib/tool-scan.js";

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
    /**
     * The host exposes its layer stacks as `tools.layers`, and tool attribution
     * walks `layers.global.tools.entries()` to learn what was registered *before*
     * this plugin mounted (the common case: we are the last bundle). A fake
     * without it silently loses every pre-existing tool, so it is mirrored here.
     */
    layers: {
      get global() {
        return {
          tools: {
            entries: () => tools.entries(),
            values: () => tools.values(),
          },
        };
      },
    },
    register(definition) {
      if (tools.has(definition.name)) throw new Error(`duplicate tool ${definition.name}`);
      tools.set(definition.name, definition);
      return () => {
        if (tools.get(definition.name) === definition) tools.delete(definition.name);
      };
    },
    /**
     * Register into one agent's layer instead of the global one.
     *
     * Still funnels through `register()` on purpose: on the host a scoped
     * registration is an ordinary `register` call made on a scoped context, so
     * attribution sees it and family discovery counts it. Only *visibility* is
     * narrowed, which is what the schedule bundle relies on.
     */
    registerScoped(definition, agent) {
      const dispose = this.register(definition);
      tools.delete(definition.name);
      let layer = scopedTools.get(agent);
      if (layer === undefined) {
        layer = new Map();
        scopedTools.set(agent, layer);
      }
      layer.set(definition.name, definition);
      return () => {
        layer.delete(definition.name);
        dispose();
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
    // `tools` MUST resolve: the owner index learns pre-existing registrations by
    // reading `tools.layers.global.tools` the first time the service is resolved,
    // and family discovery is derived from exactly that set.
    if (name === "tools") return toolsService;
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

/**
 * Fixture packages for attribution.
 *
 * Tool ownership is resolved by walking the call stack to the nearest
 * `package.json`, so a tool registered from *this* file would be attributed to
 * the plugin itself and skipped. Real plugins register from their own frames, so
 * the harness writes stand-in packages to a temp directory — outside the plugin's
 * own root — and registers through them. That is what makes attribution, and
 * therefore family discovery, exercised rather than stubbed.
 */
const FIXTURE_ROOT = path.join(os.tmpdir(), "dsh-tool-gate-fixtures");
const FIXTURE_MODULES = path.join(FIXTURE_ROOT, "node_modules");
const fixtureModules = new Map();
const fixtureBundles = new Set();

// The on-disk scan (`lib/tool-scan.js`) reads the *profile*, so point it at this
// fixture tree. That way a tool registered before the plugin mounts is placed by
// reading the package that declares it — exactly the path a freshly installed
// plugin takes on a real machine.
process.env.DSH_PROFILE_DIR = FIXTURE_ROOT;

function writeProfileManifest() {
  fs.mkdirSync(FIXTURE_ROOT, { recursive: true });
  fs.writeFileSync(
    path.join(FIXTURE_ROOT, "package.json"),
    JSON.stringify(
      {
        name: "dsh-tool-gate-e2e-profile",
        private: true,
        dsh: { profile: { bundles: [...fixtureBundles].sort() } },
      },
      null,
      2,
    ),
  );
  // The scan caches its index per profile root, so a package added mid-run has to
  // invalidate it — the host never does this, because installing a plugin restarts it.
  forgetScanCache();
}

/** Which package each test tool belongs to. Anything unlisted goes to a catch-all. */
const TOOL_PACKAGE = {
  blender_rt_do: "dsh-blender-plugin",
  blender_rt_see: "dsh-blender-plugin",
  blender_rt_cmd: "dsh-blender-plugin",
  gh_repo: "@perrylink/dsh-github",
  gh_file: "@perrylink/dsh-github",
  generate_image: "dsh-image-gen",
  edit_image: "dsh-image-gen",
  free_search_test: "dsh-free-search",
  advanced_search: "dsh-free-search",
  hindsight_list: "@vectorize-io/hindsight-coding-agents",
  session_search: "@deepseek-ai/dsh-tool-session-query",
  session_trace: "@deepseek-ai/dsh-tool-session-query",
  schedule_create: "@deepseek-ai/dsh-tool-schedule",
  schedule_update: "@deepseek-ai/dsh-tool-schedule",
  schedule_list: "@deepseek-ai/dsh-tool-schedule",
  schedule_delete: "@deepseek-ai/dsh-tool-schedule",
  workflow: "@deepseek-ai/dsh-tool-workflow", // resident: defines no family
  video_probe: "dsh-video-storyboard",
  mcp_connector_status: "dsh-mcp-connector",
};
const MISC_PACKAGE = "dsh-e2e-misc";

/** A newline, spelled without a backslash so no transfer layer can eat it. */
const NL = String.fromCharCode(10);

/**
 * Create (once) a stand-in package and import it.
 *
 * The package is written under `<fixture profile>/node_modules/<name>`, and every
 * tool it registers is also recorded in a `tools.js` listing shaped like the real
 * bundles' — `{ name: "…" }` entries. That literal is what `lib/tool-scan.js`
 * looks for, so a tool registered *before* this plugin mounts is still placed by
 * reading the package on disk: the same path a freshly installed plugin takes.
 */
async function fixtureModule(pkg, toolName) {
  const dir = path.join(FIXTURE_MODULES, ...pkg.split("/"));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: pkg, version: "0.0.0", type: "module", private: true }, null, 2),
  );

  const entryPoint = path.join(dir, "index.js");
  if (!fs.existsSync(entryPoint)) {
    fs.writeFileSync(
      entryPoint,
      [
        "export function register(tools, definition) {",
        "  return tools.register(definition);",
        "}",
        "",
      ].join(NL),
    );
    fixtureModules.delete(pkg);
  }

  if (typeof toolName === "string" && toolName !== "") {
    const listing = path.join(dir, "tools.js");
    const current = fs.existsSync(listing)
      ? fs.readFileSync(listing, "utf8")
      : ["export const definitions = [", "];", ""].join(NL);
    const marker = 'name: "' + toolName + '"';
    if (!current.includes(marker)) {
      const entry = "  { name: \"" + toolName + "\", description: \"" + toolName + " does things\" }," + NL;
      fs.writeFileSync(listing, current.replace(/^\];$/mu, entry + "];"));
    }
  }

  if (!fixtureBundles.has(pkg)) {
    fixtureBundles.add(pkg);
    writeProfileManifest();
  }

  if (fixtureModules.has(pkg)) return fixtureModules.get(pkg);
  const module = await import(pathToFileURL(entryPoint).href);
  fixtureModules.set(pkg, module);
  return module;
}

/** The definition shape every fake tool uses. */
function definitionOf(name) {
  return {
    name,
    description: `${name} does things`,
    parameters: { type: "object", additionalProperties: true },
    output: { schema: { type: "json" }, render: (_args, value) => value?.content ?? [] },
    async execute(args) {
      return { content: [{ type: "text", text: `${name} ran with ${JSON.stringify(args)}` }] };
    },
  };
}

/** Register a third-party-looking tool from a stand-in package's frame. */
async function addTool(host, name, packageName = TOOL_PACKAGE[name] ?? MISC_PACKAGE) {
  const module = await fixtureModule(packageName, name);
  module.register(host.tools, definitionOf(name));
}

/**
 * Register into one agent's layer, still through a package frame.
 *
 * Visibility is narrowed; attribution is not. That is how the schedule bundle
 * registers its four tools, and the reason a scope-less `schemas()` call cannot
 * see them.
 */
async function addScopedTool(host, agent, name, packageName = TOOL_PACKAGE[name] ?? MISC_PACKAGE) {
  const module = await fixtureModule(packageName, name);
  return module.register(host.tools, definitionOf(name));
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
    await addTool(host, name);
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
    await addTool(host, name);
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
  await addTool(host, "workflow");
  await addTool(host, "blender_rt_do");
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
  await addTool(host, "run_code");
  await addTool(host, "blender_rt_do");
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
  await addTool(host, "workflow");
  await addTool(host, "blender_rt_do");
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
  for (const name of ["workflow", "blender_rt_do"]) await addTool(host, name);
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
    await addTool(host, name);
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
  for (const name of ["workflow", "session_search", "blender_rt_do"]) await addTool(host, name);
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
  for (const name of ["workflow", "generate_image", "edit_image", "free_search_test"]) await addTool(host, name);
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

  // A plugin can declare its own entry immutable instead of relying on our
  // hard-coded name list. `mutable` is not interpreted by the host — it stores
  // the registration object as given — so this is a convention with the
  // registrant, and the declaration must win. Uses a name from the static
  // attribution table, so the entry really is attributable: an unattributed
  // entry would stay untouched for an entirely different reason and this
  // assertion would pass without testing anything.
  host.systemPrompt.context({
    name: "dsh-image-gen:canvas",
    order: 60,
    mutable: false,
    text: "Canvas rules are pinned by the deployment; do not summarize them away.",
  });
  const pinned = await host.assemble(agent);
  assert.equal(
    pinned.contexts.find((c) => c.name === "dsh-image-gen:canvas").text,
    "Canvas rules are pinned by the deployment; do not summarize them away.",
    "a `mutable: false` entry is never blanked, even though its family is collapsed and its plugin is switched on",
  );
  assert.equal(
    pinned.contexts.find((c) => c.name === "dsh-image-gen:image-defaults").text,
    "",
    "and the mutable sibling in the same plugin is still blanked",
  );

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
  for (const name of ["workflow", "generate_image", "edit_image"]) await addTool(host, name);
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
  for (const name of ["workflow", "session_search", "blender_rt_do", "gh_repo"]) await addTool(host, name);
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
  // Families are derived from the tools actually registered in this host, so the
  // count is three here (one per owning package) — the assertion is that every
  // one of them is listed, not that a fixed number exists.
  assert.ok(value.families.length >= 3, "every derived family is listed");
  assert.deepEqual(
    value.families.map((family) => family.gateway).sort(),
    ["blender", "github", "session"],
    "the gateway names come from the label hints",
  );
  const session = value.families.find((family) => family.gateway === "session");
  assert.ok(session.count >= 1, "the session family reports its live member count");
  assert.ok(session.tokens > 0, "and a token weight");
  assert.equal(session.builtin, true, "a first-party package is marked builtin");
  assert.equal(session.auto, true, "and marked as discovered rather than configured");
  // A family with no members has nothing behind its gateway; the page hides the
  // row and the gateway is not mounted. `hidden` is what the client keys on.
  for (const family of value.families) {
    assert.equal(
      family.hidden,
      family.count === 0,
      `hidden must mirror membership (family ${family.id}, count ${family.count})`,
    );
  }
  assert.ok(
    value.plugins.some((pluginRow) => pluginRow.package === "dsh-free-search"),
    "the injected prompt text is attributed to its plugin",
  );
  // Schema v2 adds the two things the page needs to explain itself: why a row is
  // greyed out, and which tools are on the wire in no family.
  assert.equal(value.schemaVersion, 2, "the payload is the documented v2 shape");
  assert.ok(Array.isArray(value.ungrouped), "ungrouped tools are reported, not silently dropped");
  for (const ungrouped of value.ungrouped) {
    assert.equal(typeof ungrouped.name, "string");
    assert.ok(
      ["resident", "mcp", "unowned"].includes(ungrouped.reason),
      `unknown ungrouped reason: ${ungrouped.reason}`,
    );
  }
  assert.ok(
    value.ungrouped.every((row) => row.name !== "read" || row.reason === "resident"),
    "a harness tool that is resident by design says so",
  );
  for (const pluginRow of value.plugins) {
    assert.equal(typeof pluginRow.reason, "string", `${pluginRow.package} states a reason`);
    // The row's switch must agree with its reason: only `ready` is switchable.
    assert.equal(
      pluginRow.disclosureAvailable,
      pluginRow.reason === "ready",
      `${pluginRow.package}: disclosureAvailable must follow reason`,
    );
  }
  assert.ok(
    value.config.diskScan === "on" || value.config.diskScan === "off",
    "the page can read the scan switch",
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
  await addTool(host, "workflow");
  plugin.apply(host.ctx, Config({ enabled: true, builtinFamilies: true }));
  const agent = { id: "s13", session: { log: [] } };
  host.agents.push(agent);
  for (const name of ["schedule_create", "schedule_delete", "schedule_list", "schedule_update"]) {
    await addScopedTool(host, agent, name);
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

// ————————————————————————————————————————————————————————————————
// 15. The gate never attributes other plugins' work to itself
// ————————————————————————————————————————————————————————————————
// Attribution used to read `ctx.fiber.name` and walk the stack, both of which
// resolve to *this* plugin. The settings page then showed a `dsh-tool-gate` row
// carrying every other package's tool and prompt-section names — the row looked
// like a plugin with 15 tools and 0 owners, and the real owners were invisible.
{
  const host = createHost({
    webServer: {
      register(route) {
        this.routes ??= new Map();
        this.routes.set(route.path, route);
        return () => this.routes.delete(route.path);
      },
    },
  });
  await addTool(host, "workflow");
  await addTool(host, "acme_gadget_a", "dsh-acme-gadgets");
  await addTool(host, "acme_gadget_b", "dsh-acme-gadgets");
  plugin.apply(host.ctx, Config({ enabled: true }));
  const agent = { id: "s15", session: { log: [] } };
  host.agents.push(agent);
  await host.assemble(agent);

  let payload;
  const route = host.ctx.get("webServer", false).routes.get("/api/dsh-tool-gate/describe");
  await route.handler(
    {
      method: "GET",
      headers: { host: "127.0.0.1:52993" },
      socket: { remoteAddress: "127.0.0.1", localAddress: "127.0.0.1" },
    },
    { writeHead: () => {}, end: (body) => { payload = JSON.parse(body); } },
  );

  const self = payload.value.plugins.find((row) => row.package === "dsh-tool-gate");
  assert.ok(!self || self.toolCount === 0, "the gate claims no tools of its own");
  assert.ok(
    self === undefined || (self.names ?? []).length === 0,
    `the gate claims no prompt sections of its own (got ${(self?.names ?? []).join(",")})`,
  );
  const gadgets = payload.value.plugins.find((row) => row.package === "dsh-acme-gadgets");
  assert.ok(gadgets !== undefined, "the real owner is listed instead");
  assert.equal(gadgets.toolCount, 2, "with exactly its own tools");
  assert.ok(
    !payload.value.families.some((family) => family.id === "dsh-tool-gate"),
    "and the gate never becomes a family of its own",
  );
  console.log("OK attribution never self-pollutes");
}

// ————————————————————————————————————————————————————————————————
// 14. A plugin nobody has ever heard of becomes a family on its own
// ————————————————————————————————————————————————————————————————
// This is the whole point of deriving the partition instead of listing it: the
// package below appears in no table anywhere in this repository, and still gets a
// working gateway in the very first assembly after it is registered.
{
  const host = createHost();
  await addTool(host, "workflow");
  await addTool(host, "acme_widget_create", "dsh-acme-widgets");
  await addTool(host, "acme_widget_list", "dsh-acme-widgets");
  await addTool(host, "acme_widget_delete", "dsh-acme-widgets");
  plugin.apply(host.ctx, Config({ enabled: true }));
  const agent = { id: "s14", session: { log: [] } };
  host.agents.push(agent);
  const assembly = await host.assemble(agent);
  const names = assembly.tools.map((tool) => tool.name);

  assert.ok(names.includes("acme_widgets"), `a derived gateway appears (got ${names.join(",")})`);
  assert.ok(!names.includes("acme_widget_create"), "its members are collapsed");
  assert.ok(!names.includes("acme_widget_list"), "every one of them");
  assert.ok(names.includes("workflow"), "resident tools are untouched");

  // The gateway is fully functional, not decoration.
  const listed = await host.tools.execute({
    callId: "c14",
    name: "acme_widgets",
    arguments: { action: "list" },
    agent,
  });
  const payload = JSON.parse(listed.content[0].text);
  assert.deepEqual(
    payload.members.map((member) => member.name),
    ["acme_widget_create", "acme_widget_delete", "acme_widget_list"],
    "and it lists its own members",
  );

  // And it dispatches.
  const called = await host.tools.execute({
    callId: "c14b",
    name: "acme_widgets",
    arguments: { action: "call", tool: "acme_widget_create", arguments: { size: 3 } },
    agent,
  });
  assert.equal(called.isError, false);
  assert.match(called.content[0].text, /acme_widget_create ran with/);
  assert.match(called.content[0].text, /"size":3/, "the arguments reached the member");

  // Turning auto-discovery off must leave the world exactly as it was.
  const manual = createHost();
  await addTool(manual, "workflow");
  await addTool(manual, "acme_widget_create", "dsh-acme-widgets");
  plugin.apply(manual.ctx, Config({ enabled: true, autoFamilies: false }));
  const manualAgent = { id: "s14c", session: { log: [] } };
  manual.agents.push(manualAgent);
  const manualAssembly = await manual.assemble(manualAgent);
  assert.ok(
    manualAssembly.tools.some((tool) => tool.name === "acme_widget_create"),
    "autoFamilies:false keeps unknown plugins resident",
  );
  assert.ok(
    !manualAssembly.tools.some((tool) => tool.name === "acme_widgets"),
    "and registers no gateway for them",
  );
  console.log("OK an unknown plugin becomes its own family");
}

console.log("\nALL END-TO-END CHECKS PASSED");
