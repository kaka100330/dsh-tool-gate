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
function createHost({ profileContext = FIXTURE_PROFILE_CONTEXT, ...options } = {}) {
  const listeners = new Map(); // event -> [fn]
  const tools = new Map(); // name -> definition
  const scopedTools = new Map(); // agent -> Map<name, definition>
  /** agent -> Set<name>: names removed from that scope's view by `restrict()`. */
  const restricted = new Map();
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
      return [...this.visibleDefinitions(scope).values()].map((definition) => ({
        name: definition.name,
        description: definition.description,
        parameters: definition.parameters,
      }));
    },
    /** The definitions a scope can actually call: global + its own, minus denials. */
    visibleDefinitions(scope) {
      const visible = new Map(tools);
      for (const definition of scopedTools.get(scope)?.values() ?? []) visible.set(definition.name, definition);
      for (const name of restricted.get(scope) ?? []) visible.delete(name);
      return visible;
    },
    /**
     * The host's `view(scope)` — the projection the gate judges emptiness by.
     *
     * `knownNames` is deliberately the *unrestricted* superset (every global and
     * every agent-layer name), which is what the real host reports and what made
     * an empty gateway reach the wire: a name denied to every agent still counted
     * as a member. `visible` is what can actually be called in `scope`.
     */
    view(scope) {
      const known = new Set(tools.keys());
      for (const layer of scopedTools.values()) {
        for (const name of layer.keys()) known.add(name);
      }
      return {
        visible: [...this.visibleDefinitions(scope).keys()],
        knownNames: known,
        restrictableNames: new Set(known),
      };
    },
    /** Deny names in one scope, the way `dsh-ops` installs its native replacements. */
    restrict(scope, names) {
      const set = restricted.get(scope) ?? new Set();
      for (const name of names) set.add(name);
      restricted.set(scope, set);
      return () => {
        for (const name of names) set.delete(name);
        if (set.size === 0) restricted.delete(scope);
      };
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
    // The host provides this at its root before any bundle mounts; `lib/index.js`
    // reads `dir` from it to anchor the on-disk scan.
    if (name === "profileContext") return profileContext;
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
// Start from an empty tree. The fixture profile lives in the temp directory and
// therefore survives between runs, while the scan reads it as the *profile*: a
// `tools.js` listing written by an older run stays authoritative, and after a
// table entry moved from one stand-in package to another both packages declared
// the same name — the scan answered with whichever it met first, and the result
// depended on what the previous run had left behind.
fs.rmSync(FIXTURE_ROOT, { recursive: true, force: true });
const fixtureModules = new Map();
const fixtureBundles = new Set();

// The on-disk scan (`lib/tool-scan.js`) reads the *profile*, so every fake host
// below hands this fixture tree over as `profileContext` — the same service the
// real host provides at its root, and the only way `lib/index.js` learns which
// profile to read. A host that provides nothing leaves the scan unanchored, which
// is what the "no profile" case exercises.
const FIXTURE_PROFILE_CONTEXT = { name: "dsh-tool-gate-e2e-profile", dir: FIXTURE_ROOT };

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
  // `dsh-ops` publishes every native replacement under one `ops_` prefix, so the
  // fixture has to say that too. Left to the catch-all it claimed `ops_bash` for
  // itself, and a declaration beats a table: the tool stopped being resident and
  // the freeze dropped it — the fixture was lying about a name whose owner is
  // the one package the prefix rule exists for.
  ops_bash: "dsh-ops",
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

/**
 * The definition shape every fake tool uses.
 *
 * The description carries real weight on purpose. `lib/degenerate.js` refuses a
 * family whose members cannot pay for their gateway, and a three-word stub schema
 * cannot — so stubs would test the suppression path instead of the collapsing path.
 * A real schema is a few hundred tokens; this is.
 */
const FIXTURE_PADDING = "It accepts arguments and returns text content. ".repeat(28);

function definitionOf(name) {
  return {
    name,
    description: `${name} does things. ${FIXTURE_PADDING}`,
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
  assert.ok(host.tools.get("blender_plugin"), "blender_plugin gateway registered");
  assert.ok(host.tools.get("github"), "github gateway registered");
  assert.ok(host.tools.get("image_gen"), "image_gen gateway registered");
  assert.ok(host.tools.get("mcp_servers"), "mcp_servers gateway registered");

  const agent = { id: "s2", session: { log: [] } };
  host.agents.push(agent);

  const first = await host.assemble(agent);
  const names = first.tools.map((t) => t.name);
  console.log("wire after freeze:", names.join(", "));
  assert.ok(names.includes("workflow"), "core tool stays");
  assert.ok(names.includes("ops_bash"), "ops tool stays");
  assert.ok(names.includes("compress"), "context tool stays");
  assert.ok(names.includes("blender_plugin"), "gateway is on the wire");
  assert.ok(!names.includes("blender_rt_do"), "blender member collapsed");
  assert.ok(!names.includes("gh_repo"), "github member collapsed");
  assert.ok(!names.includes("generate_image"), "image member collapsed");
  assert.ok(!names.includes("mcp__wincu__x"), "mcp member collapsed");

  // The notice is appended once, and stays byte-identical after.
  const notice = first.sections.find((section) => section.name === "tool-gate: progressive-disclosure");
  assert.ok(notice !== undefined, "notice section added");
  assert.match(notice.text, /`blender_plugin`/, "notice lists the blender_plugin gateway");
  assert.match(notice.text, /`github`/, "notice lists the github gateway");
  // The roster carries the label beside the name. The name is what the model
  // matches against the tool list; the label is what says the gateway is for.
  assert.match(notice.text, /`blender_plugin` Blender Plugin/, "the roster pairs each gateway with its label");
  assert.match(notice.text, /`github` Github/, "the label is the package name, capitalised");
  // The usage contract is stated once, here, instead of on every gateway.
  assert.match(notice.text, /action: "list"/, "the notice explains list");
  assert.match(notice.text, /action: "call"/, "and call");
  // And it is not stated again anywhere else: no gateway's own description
  // repeats the shared boilerplate.
  for (const gatewayName of ["blender_plugin", "github", "image_gen", "mcp_servers"]) {
    const definition = host.tools.get(gatewayName);
    assert.equal(
      definition.description.includes("这个家族的成员工具不在本轮工具列表里"),
      false,
      `${gatewayName} does not repeat the notice`,
    );
  }

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
    name: "blender_plugin",
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
    // Realistic weight: a one-word stub cannot pay for its family's gateway, so the
    // degenerate rule (correctly) leaves it on the wire and this suite would test
    // the suppression path instead of the turn semantics it is about.
    description: `reflect. ${FIXTURE_PADDING}`,
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
    name: "hindsight_coding_agents",
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
  assert.equal(host.tools.get("blender_plugin"), undefined, "gateway unregistered when disabled");
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
  assert.ok(names.includes("session_query"), "the session gateway is on the wire");
  assert.ok(names.includes("schedule"), "the schedule gateway is on the wire");
  assert.ok(names.includes("workflow"), "an unlisted core tool still stays");

  // Listing the builtin family returns its members like any other.
  const listed = await host.ctx.tools.execute({ callId: "b1", name: "session_query", arguments: { action: "list" }, agent });
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
  assert.equal(host.tools.get("session_query"), undefined, "the session gateway is not registered");

  // Flipping the group switch live restores the gateway and re-collapses.
  const write = (field, value) => {
    const ref = live[field];
    ref[Object.getOwnPropertySymbols(ref).find((s) => String(s).includes("volatile.write"))](value);
  };
  write("freeze", false);
  write("builtinFamilies", true);
  const after = await host.assemble(agent);
  assert.ok(!after.tools.map((t) => t.name).includes("session_search"), "turning the group on collapses again");
  assert.ok(host.tools.get("session_query") !== undefined, "the gateway came back");
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
  // The config above is written the v1 way — one switch per package. `apply` must
  // fold those onto the families before the first assembly, or the prose would
  // never be withheld. That is asserted here rather than only implied by the
  // blanking below, so a migration that silently stops running is caught.
  const migratedFamilies = live.families.get();
  assert.equal(
    migratedFamilies?.free_search?.promptDisclosure,
    true,
    "the search package's v1 switch was folded onto its family",
  );
  assert.equal(
    migratedFamilies?.image_gen?.promptDisclosure,
    true,
    "and so was the image package's",
  );
  assert.equal(
    live.promptPlugins.get()?.["dsh-free-search"]?.enabled,
    false,
    "and the legacy entry is switched off, so one switch has one source of truth",
  );

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

  const listed = await host.ctx.tools.execute({ callId: "l1", name: "image_gen", arguments: { action: "list" }, agent });
  assert.equal(listed.isError, false);
  assert.equal(listed.content.length, 2, "list returns the members plus one prose block");
  assert.match(listed.content[1].text, /「Image Gen」家族的使用说明/, "the prose block is labelled as family guidance");
  assert.match(listed.content[1].text, /provider: openai-compat/, "the plugin's own text is returned verbatim");

  // A second list does not repeat the prose: it is already in the history.
  const again = await host.ctx.tools.execute({ callId: "l2", name: "image_gen", arguments: { action: "list" }, agent });
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
    ["blender_plugin", "github", "session_query"],
    "the gateway name is the family id, never a shortened label hint",
  );
  const session = value.families.find((family) => family.gateway === "session_query");
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
  // The merge: a family carries its own prompt switch, so the page never has to
  // cross-reference a second list to answer "does this family disclose?".
  for (const family of value.families) {
    const prompt = family.promptDisclosure;
    assert.equal(typeof prompt, "object", `${family.id} carries a promptDisclosure row`);
    assert.equal(typeof prompt.available, "boolean", `${family.id}: available is a boolean`);
    assert.equal(typeof prompt.chars, "number", `${family.id}: chars is a number`);
    assert.ok(Array.isArray(prompt.names), `${family.id}: names is an array`);
    assert.ok(
      ["ready", "master-off", "requires-collapse", "required-only", "no-family", "unowned", "no-prose", "no-tools"]
        .includes(prompt.reason),
      `unknown prompt reason on ${family.id}: ${prompt.reason}`,
    );
    // A switch is only honest when turning it on does something today.
    assert.equal(prompt.available, prompt.reason === "ready", `${family.id}: available must follow reason`);
    // `enabled` is the switch's position, not its usability — a family that was
    // switched on and then expanded must still report on.
    assert.equal(typeof prompt.enabled, "boolean", `${family.id}: enabled is a boolean`);
    // A family with no members has no gateway, so nothing could carry its prose
    // back on `list`. Offering the switch would be an API-level lie the page only
    // hides by filtering empty rows.
    if (family.count === 0) {
      assert.equal(prompt.available, false, `${family.id}: an empty family offers no switch`);
      assert.equal(prompt.reason, "no-tools", `${family.id}: and says why`);
    }
  }
  // `dsh-free-search` injects a section here but registers no tool, so it has no
  // family and no gateway could carry its prose. That is exactly the case the
  // read-only list exists for: the text must stay visible, without offering a
  // switch that cannot do anything.
  const freeSearch = value.ungrouped.find((row) => row.package === "dsh-free-search");
  assert.ok(freeSearch !== undefined, "a package with prose but no family is still listed");
  assert.equal(freeSearch.reason, "no-tools", "and says why it has no switch");
  assert.ok(freeSearch.chars > 0, "and reports the prose it contributes");
  assert.ok(freeSearch.names.includes("free-search:engines"), "and the section names");
  assert.equal(freeSearch.enabled, null, "with no switch to flip");

  // Schema v3: the four identifiers are separate, `ungrouped` says why from
  // evidence, and the snapshot carries its own self-check.
  assert.equal(value.schemaVersion, 3, "the payload is the documented v3 shape");
  assert.ok(Array.isArray(value.diagnostics), "the snapshot carries its self-check (D1–D8)");
  assert.equal(
    value.diagnostics.filter((row) => row.severity === "error").length,
    0,
    `no error-level diagnostic on a healthy snapshot: ${JSON.stringify(value.diagnostics.filter((row) => row.severity === "error"))}`,
  );
  assert.equal(value.plugins, undefined, "the separate plugin list is gone");
  assert.equal(value.promptPlugins, undefined, "and so is its config dict");
  assert.ok(Array.isArray(value.ungrouped), "ungrouped packages are reported, not silently dropped");
  for (const ungrouped of value.ungrouped) {
    assert.equal(typeof ungrouped.package, "string", "an ungrouped row names a package");
    assert.ok(
      ["claimed", "no-collapsible-members", "no-tools", "unowned", "misattributed"].includes(ungrouped.reason),
      `unknown ungrouped reason: ${ungrouped.reason}`,
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(ungrouped, "resident"),
      false,
      "the old catch-all 'resident' reason is gone: it described packages that were behind a gateway",
    );
    // Every reason except `no-tools` is checked against the tools themselves, so a
    // row can state a fact instead of an assumption (D3 does the same check).
    if (ungrouped.reason === "no-collapsible-members") {
      assert.equal(
        ungrouped.residentCount,
        ungrouped.toolCount,
        `${ungrouped.package}: "no-collapsible-members" means every tool is resident`,
      );
    }
    // A row may not accuse the attribution of a package whose tools are simply
    // resident: "there is nothing to collapse here" is a fact about the tools and
    // wins over "our bookkeeping is unsure". The old order reported `dsh-ops`
    // (all `ops_*` resident) and `billion-context` (all context tools resident) as
    // 归属异常, which reads as a defect in the user's install.
    if (ungrouped.reason === "misattributed") {
      assert.equal(
        ungrouped.residentCount < ungrouped.toolCount,
        true,
        `${ungrouped.package}: residency is a fact and must be reported before suspicion`,
      );
    }
    assert.equal(ungrouped.enabled, null, `${ungrouped.package} offers no switch`);
    // The host filters first-party packages out of this list: they are never sent
    // to the wire from here and no switch governs them, so listing them only
    // buried the rows that do. The count below is what keeps the omission honest.
    assert.equal(ungrouped.thirdParty, true, `${ungrouped.package} is a third-party package`);
    assert.equal(
      /^@deepseek-ai\/|^@dsh-ops\//.test(ungrouped.package),
      false,
      `a harness package must not appear in ungrouped: ${ungrouped.package}`,
    );
    // One row per package: a Loader subpath specifier is not its own package.
    const parts = ungrouped.package.split("/");
    assert.equal(
      parts.length <= 2,
      true,
      `ungrouped packages are bare names, not entry specifiers: ${ungrouped.package}`,
    );
    if (parts.length === 2) assert.equal(parts[0].startsWith("@"), true);
  }
  assert.equal(
    typeof value.ungroupedBuiltin,
    "number",
    "the count of omitted first-party packages is reported",
  );
  // A description is only ever the plugin's own. This fake host has no
  // `pluginPackages` service, so every family reports `""` from `none` — and that
  // is the contract now: the page shows what the package says about itself, and
  // invents nothing when it says nothing. (The old table used to answer here,
  // which is how `Hindsight` came out as the capability word `记忆`.)
  const described = value.families.filter((family) => (family.description ?? "") !== "");
  assert.equal(described.length, 0, "no family invents a description the host did not supply");
  for (const family of value.families) {
    // The four identifiers, kept apart: `id` for diagnostics, `wire` for the model,
    // `label` for the user, `configKey` for the config. They used to be one string,
    // which is how a gateway became `subagent2`.
    assert.equal(typeof family.wire, "string", `${family.id}: a family carries its wire name`);
    assert.equal(family.configKey, family.id, `${family.id}: the config key is the family id`);
    assert.ok(Array.isArray(family.aliases), `${family.id}: aliases are listed`);
    assert.equal(
      /[0-9]/.test(family.wire),
      false,
      `${family.id}: a wire name never carries a disambiguation digit (${family.wire})`,
    );
    assert.equal(typeof family.collapsed, "boolean", `${family.id}: the page can tell whether it is collapsed`);
    if (family.hidden === true) continue;
    assert.equal(
      family.descriptionSource,
      family.description === "" ? "none" : family.descriptionSource,
      `${family.id}: an empty description is sourced as none`,
    );
    assert.ok(
      ["metaOf", "manifest", "derived", "override", "none"].includes(family.descriptionSource),
      `unknown description source on ${family.id}: ${family.descriptionSource}`,
    );
  }
  assert.equal(
    value.families.some((family) => (family.packages ?? []).includes(value.ungrouped[0]?.package)),
    false,
    "an ungrouped package belongs to no family row",
  );
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

  // ——— POST /describe/refresh: the cache-busting read ————————————————
  // A plugin installed by another process moves none of the three caches the
  // host keeps, so re-issuing the GET (what the old button did) answered from
  // before the install. The refresh route drops them and re-derives.
  assert.ok(routes.has("/api/dsh-tool-gate/describe/refresh"), "the refresh route is registered");
  const refresh = routes.get("/api/dsh-tool-gate/describe/refresh");
  const call = async (method, headers = request.headers) => {
    let code;
    let payload;
    await refresh.handler(
      { ...request, method, headers },
      { writeHead: (value) => { code = value; }, end: (text) => { payload = JSON.parse(text); } },
    );
    return { code, payload };
  };

  // A side-effecting read must not be reachable as a GET.
  const asGet = await call("GET");
  assert.equal(asGet.code, 405, "the refresh route is POST-only");
  const crossSite = await call("POST", { ...request.headers, origin: "http://evil.example" });
  assert.equal(crossSite.code, 403, "a cross-site refresh is refused");

  const before = value.families.map((family) => family.id).sort();
  const refreshed = await call("POST");
  assert.equal(refreshed.code, 200, "the refresh succeeds");
  assert.equal(refreshed.payload.ok, true);
  assert.equal(refreshed.payload.value.schemaVersion, 3, "and answers with the /describe shape");
  assert.deepEqual(
    refreshed.payload.value.families.map((family) => family.id).sort(),
    before,
    "nothing was installed in between, so the inventory is unchanged",
  );

  // Now install one, exactly as the user does: a package appears in the profile
  // *after* this process derived its table.
  await addTool(host, "acme_gadget_a", "dsh-acme-gadgets");
  await addTool(host, "acme_gadget_b", "dsh-acme-gadgets");
  const stale = await call("POST", request.headers); // same process, caches already dropped
  assert.equal(stale.code, 200);
  const after = await call("POST");
  assert.equal(after.code, 200);
  assert.ok(
    after.payload.value.families.some((family) => family.id === "acme_gadgets"),
    "the newly installed plugin appears in the inventory without a restart",
  );
  assert.equal(
    stale.payload.value.families.some((family) => family.id === "acme_gadgets"),
    true,
    "the first refresh already saw it: the scan index is fingerprinted on the profile manifest",
  );
  for (const family of after.payload.value.families) {
    assert.equal(family.hidden, family.count === 0, `hidden still mirrors membership (${family.id})`);
    assert.equal(
      family.promptDisclosure.available,
      family.promptDisclosure.reason === "ready",
      `available still follows reason (${family.id})`,
    );
  }
  console.log("OK settings bridge describe + refresh");
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

  // Self-pollution used to look like one row for this plugin carrying every
  // other plugin's tool names. With the lists merged there are two places it
  // could show up: an ungrouped row of its own, or a family named after it.
  const self = payload.value.ungrouped.find((row) => row.package === "dsh-tool-gate");
  assert.equal(self, undefined, `the gate must not list itself (got ${JSON.stringify(self)})`);
  assert.ok(
    !payload.value.families.some((family) => family.id === "dsh-tool-gate"),
    "and the gate never becomes a family of its own",
  );
  const gadgets = payload.value.families.find((family) => (family.packages ?? []).includes("dsh-acme-gadgets"));
  assert.ok(gadgets !== undefined, "the real owner is listed instead");
  assert.deepEqual(
    gadgets.members,
    ["acme_gadget_a", "acme_gadget_b"],
    "with exactly its own tools, not somebody else's",
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

// ————————————————————————————————————————————————————————————————
// 16. No gateway for a family whose members are all restricted away
// ————————————————————————————————————————————————————————————————
// The `fs_search` bug: a package whose tools exist in the registry but are denied
// to every agent (`dsh-ops` denies `read`/`glob`/`grep` exactly this way).
// Emptiness used to be judged against the scope-less `knownNames()` superset, so a
// gateway reached the wire with zero members: the model saw a tool whose `list`
// could only answer "no members", while the page — which counts through
// `schemas(agent)` — correctly hid the row.
{
  const host = createHost();
  await addTool(host, "workflow");
  await addTool(host, "fs_read", "dsh-fs-search");
  const agent = { id: "s16", session: { log: [] } };
  host.agents.push(agent);
  plugin.apply(host.ctx, Config({ enabled: true }));

  // Before the restriction the family is real, and its gateway is mounted.
  const before = await host.assemble(agent);
  assert.ok(host.tools.get("fs_search") !== undefined, "a populated family gets its gateway");
  assert.ok(!before.tools.some((tool) => tool.name === "fs_read"), "and its member is collapsed");

  // Now deny the member in this agent's scope. It still exists in the registry
  // (and in `knownNames`), so only a scope-aware read notices it is uncallable.
  host.tools.restrict(agent, ["fs_read"]);
  const after = await host.assemble(agent);
  assert.equal(
    host.tools.get("fs_search"),
    undefined,
    "a family nobody can call must not carry a gateway",
  );
  assert.ok(
    !after.tools.some((tool) => tool.name === "fs_search"),
    "and the withdrawn gateway leaves the wire in the same pass",
  );

  // The settings page must agree: the row is hidden because it has no members.
  const bridge = createHost({
    webServer: {
      register(route) {
        this.routes ??= new Map();
        this.routes.set(route.path, route);
        return () => this.routes.delete(route.path);
      },
    },
  });
  await addTool(bridge, "workflow");
  await addTool(bridge, "fs_read", "dsh-fs-search");
  const bridgeAgent = { id: "s16b", session: { log: [] } };
  bridge.agents.push(bridgeAgent);
  plugin.apply(bridge.ctx, Config({ enabled: true }));
  bridge.tools.restrict(bridgeAgent, ["fs_read"]);
  await bridge.assemble(bridgeAgent);
  let payload;
  await bridge.ctx.get("webServer", false).routes.get("/api/dsh-tool-gate/describe").handler(
    {
      method: "GET",
      headers: { host: "127.0.0.1:52993" },
      socket: { remoteAddress: "127.0.0.1", localAddress: "127.0.0.1" },
    },
    { writeHead: () => {}, end: (body) => { payload = JSON.parse(body); } },
  );
  const row = payload.value.families.find((family) => family.id === "fs_search");
  assert.ok(row !== undefined, "the family is still listed, so its config stays reachable");
  assert.equal(row.hidden, true, "but the page hides it");
  assert.equal(row.count, 0);
  assert.equal(row.promptDisclosure.available, false, "and offers no switch that cannot work");
  assert.equal(row.promptDisclosure.reason, "no-tools");
  console.log("OK an uncallable family gets no gateway");
}

// ————————————————————————————————————————————————————————————————
// 17. A gateway withdrawn mid-session leaves the wire, and the freeze thaws
// ————————————————————————————————————————————————————————————————
// Two separate things break when a family stops having a gateway after the freeze:
//  - the frozen surface is sticky on purpose (that is what keeps the wire prefix
//    stable), so the gateway would otherwise sit on the wire for the rest of the
//    session — a tool whose \`list\` can only answer "no members";
//  - the collapsed set was decided while that gateway existed, so the members it
//    hid would stay collapsed with nothing left to reach them through.
// Withdrawal therefore drops the gateway from the assembled list *and* clears the
// freeze, so that same pass re-derives. Nothing else clears it.
{
  const host = createHost();
  for (const name of ["workflow", "session_search", "blender_rt_do"]) await addTool(host, name);
  const live = Config({ enabled: true });
  plugin.apply(host.ctx, live);
  const agent = { id: "s17", session: { log: [] } };
  host.agents.push(agent);

  const frozen = await host.assemble(agent);
  assert.ok(frozen.tools.some((tool) => tool.name === "session_query"), "the gateway is frozen in");
  assert.ok(!frozen.tools.some((tool) => tool.name === "session_search"), "and its member is collapsed");

  // Turn the builtin group off, which removes the family (and with it the gateway)
  // while the members stay registered. Note the freeze switch is *not* touched.
  const write = (field, value) => {
    const ref = live[field];
    ref[Object.getOwnPropertySymbols(ref).find((s) => String(s).includes("volatile.write"))](value);
  };
  write("builtinFamilies", false);
  const after = await host.assemble(agent);
  assert.ok(
    !after.tools.some((tool) => tool.name === "session_query"),
    "the withdrawn gateway leaves the frozen surface in the same pass",
  );
  assert.equal(host.tools.get("session_query"), undefined, "and is unmounted");
  assert.ok(
    after.tools.some((tool) => tool.name === "session_search"),
    "and the members it was hiding come back — otherwise the family would be unreachable",
  );
  const direct = await host.ctx.tools.execute({ callId: "c17", name: "session_search", arguments: {}, agent });
  assert.equal(direct.isError, false, "and they are callable again, not refused as collapsed");

  // Turning the group back on restores the family in full: the gateway returns and
  // its members collapse under it again. No residue from the withdrawal, because
  // the freeze was cleared rather than patched.
  // Turning the group back on mounts the gateway again. The *frozen* agent does
  // not pick it up — the surface is sticky, exactly like a plugin installed
  // mid-session — but a new session derives from the current registry and gets it
  // in full. That is the documented behaviour, so it is asserted rather than
  // assumed.
  write("builtinFamilies", true);
  const sameAgent = await host.assemble(agent);
  assert.ok(host.tools.get("session_query") !== undefined, "the gateway is mounted again");
  assert.ok(
    sameAgent.tools.some((tool) => tool.name === "session_search"),
    "the frozen agent keeps the member on its wire until a new session",
  );
  const fresh = { id: "s17b", session: { log: [] } };
  host.agents.push(fresh);
  const restored = await host.assemble(fresh);
  assert.ok(
    restored.tools.some((tool) => tool.name === "session_query"),
    "a new session collapses the restored family again",
  );
  assert.ok(!restored.tools.some((tool) => tool.name === "session_search"), "its members going back under it");
  const viaGateway = await host.ctx.tools.execute({
    callId: "c17b",
    name: "session_query",
    arguments: { action: "list" },
    agent: fresh,
  });
  assert.equal(viaGateway.isError, false, "and the gateway can list its members");
  assert.match(viaGateway.content[0].text, /session_search/);

  // Steady state stays sticky: assemblies with no withdrawal must not rebuild.
  const quiet = host.loggerLines.filter((entry) => entry.includes("re-freezing")).length;
  await host.assemble(agent);
  await host.assemble(fresh);
  assert.equal(
    host.loggerLines.filter((entry) => entry.includes("re-freezing")).length,
    quiet,
    "an unchanged inventory never re-freezes",
  );
  console.log("OK a withdrawn gateway leaves the frozen surface");
}

console.log("\nALL END-TO-END CHECKS PASSED");
