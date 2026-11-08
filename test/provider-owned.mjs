/**
 * Contract test for the DSH 0.2.2 tool contract.
 *
 * The other suites run against a fake that speaks the 0.2.1 shape: `view()` hands
 * back `visible` as an *array*, the assemble waterfall carries `tools`, and
 * `tools.execute()` takes a single call. The real 0.2.2 host does none of those
 * things, which is why every check passed while the plugin was completely inert
 * in production:
 *
 *  - `view(scope).visible` is a `Map<name, definition>` (`knownNames` is a `Set`);
 *  - `system-prompt/assemble` carries sections/contexts/variables and the host
 *    re-attaches the provider's tool list afterwards, so a listener's `tools` is
 *    discarded;
 *  - the wire is `selectExecutor(scope).describe(definitions(scope, toolSet))`, so
 *    the only place a plugin can hide a tool is an agent-scoped executor;
 *  - `tools.execute()` is a batch call over `calls[]`.
 *
 * This file mirrors those four facts and asserts the plugin still collapses.
 */
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const PKG = path.dirname(HERE);
const at = (relative) => pathToFileURL(path.join(PKG, relative)).href;

process.env.DSH_PROFILE_DIR = path.join(os.tmpdir(), "dsh-tool-gate-provider-owned");

const { Config } = await import(at("lib/config.js"));
const plugin = await import(at("lib/index.js"));

// ————————————————————————————————————————————————————————————————
// The four 0.2.2 facts, in one fake host
// ————————————————————————————————————————————————————————————————
function createHost() {
  const listeners = new Map();
  const definitions = new Map(); // name -> definition
  const executors = new Map(); // scope -> executor
  let rootExecutor;
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

  const visible = () => new Map(definitions);

  const toolsService = {
    layers: {
      get global() {
        return { tools: { entries: () => definitions.entries(), values: () => definitions.values() } };
      },
    },
    register(definition) {
      if (definitions.has(definition.name)) throw new Error(`duplicate tool ${definition.name}`);
      definitions.set(definition.name, definition);
      return () => {
        if (definitions.get(definition.name) === definition) definitions.delete(definition.name);
      };
    },
    get(name) {
      return definitions.get(name);
    },
    /** 0.2.2: `visible` is a Map, not an array. */
    view() {
      return { visible: visible(), registrations: new Map(), knownNames: new Set(definitions.keys()), restrictableNames: new Set(definitions.keys()) };
    },
    /**
     * `schemas()` reads the *registry*, never the wire: the host projects it from
     * `view(scope).visible`, which an executor filter does not touch. That
     * distinction is what keeps `action: "list"` honest, so the fake must honour
     * it too — reading the executor here would assert the opposite of the design.
     */
    schemas() {
      return [...definitions.values()].map((definition) => ({
        name: definition.name,
        description: definition.description,
        parameters: definition.parameters,
      }));
    },
    definitions(scope) {
      return [...definitions.values()];
    },
    setExecutor(executor) {
      const scope = scopeOf();
      if (scope === undefined) {
        if (rootExecutor !== undefined) throw new Error("Only one tool executor may be registered in each scope");
        rootExecutor = executor;
      } else {
        if (executors.has(scope)) throw new Error("Only one tool executor may be registered in each scope");
        executors.set(scope, executor);
      }
      return () => {
        if (scope === undefined) rootExecutor = undefined;
        else executors.delete(scope);
      };
    },
    selectExecutor(scope) {
      const found = scope === undefined ? undefined : executors.get(scope);
      const executor = found ?? rootExecutor;
      if (executor === undefined) throw new Error("no tool executor");
      return executor;
    },
    /** 0.2.2: one batch call, resolved into a settlement. */
    async execute(input) {
      if (!Array.isArray(input.calls)) throw new TypeError("input.calls.map is not a function");
      const exec = input.agent === undefined ? rootExecutor : executors.get(input.agent) ?? rootExecutor;
      const results = [];
      for (const call of input.calls) {
        const definition = definitions.get(call.name);
        const args = typeof call.arguments === "string" ? JSON.parse(call.arguments || "{}") : call.arguments ?? {};
        if (definition === undefined) {
          results.push({ callId: call.id, result: { isError: true, error: { message: `unknown tool ${call.name}` }, content: [] } });
          continue;
        }
        const returned = await definition.execute(args, {
          callId: call.id,
          agent: input.agent,
          signal: input.signal,
          deferContext() {},
          concludeTurn() {},
        });
        results.push({ callId: call.id, result: { isError: false, content: returned?.content ?? [] } });
      }
      return { results, additionalContexts: [], concluded: false };
    },
  };

  let currentScope;
  const scopeOf = () => currentScope;

  /** The wire the host would send: root/agent executor's describe(), no waterfall involvement. */
  const wire = (scope) => {
    const executor = scope === undefined ? rootExecutor : executors.get(scope) ?? rootExecutor;
    return executor.describe([...definitions.values()]).schemas.map((schema) => schema.name);
  };

  // A root executor, like the deployment's native one.
  rootExecutor = {
    describe(tools) {
      return { schemas: tools.map((d) => ({ name: d.name, description: d.description, parameters: d.parameters })) };
    },
    execute(input) {
      return toolsService.execute(input);
    },
  };

  const agents = [];
  const ctx = {
    logger,
    tools: toolsService,
    on,
    get(name) {
      if (name === "agents") return { list: () => agents };
      if (name === "tools") return toolsService;
      return undefined;
    },
    effect(fn) {
      return fn();
    },
    inject(_names, callback) {
      return undefined;
    },
    /** Bind an agent scope for `setExecutor`, the way `agent.ctx` does. */
    enterScope(agent) {
      currentScope = agent;
      return () => {
        currentScope = undefined;
      };
    },
  };

  /** Give an agent the scoped context the plugin reaches through `agent.ctx`. */
  const makeAgent = (id) => {
    const agent = { id, session: { log: [] } };
    const scopedCtx = Object.create(toolsService);
    agent.ctx = { tools: {
      setExecutor(executor) {
        if (executors.has(agent)) throw new Error("Only one tool executor may be registered in each scope");
        executors.set(agent, executor);
        return () => executors.delete(agent);
      },
      selectExecutor() {
        return executors.get(agent) ?? rootExecutor;
      },
    } };
    agents.push(agent);
    return agent;
  };

  /** Assemble exactly like 0.2.2: no `tools` in the payload, host re-attaches its own. */
  const assemble = async (agent) => {
    const base = { sections: [{ name: "identity", text: "you are a harness" }], contexts: [], variables: {} };
    const list = [...(listeners.get("system-prompt/assemble") ?? [])];
    let index = -1;
    const next = async () => {
      index += 1;
      const fn = list[index];
      if (fn === undefined) return base;
      return fn(base, { scope: agent }, next);
    };
    const transformed = await next();
    // The host re-attaches the provider's list no matter what the listener returned.
    return { ...transformed, tools: wire(agent).map((name) => ({ name })) };
  };

  return { ctx, toolsService, assemble, wire, makeAgent, loggerLines, definitions };
}


// ————————————————————————————————————————————————————————————————
// Fixture tools, attributed to a real package on disk
// ————————————————————————————————————————————————————————————————
//
// Ownership is resolved by walking the call stack to the nearest package.json, so
// a tool registered from *this* file would be attributed to the plugin under test
// and skipped. The e2e harness writes stand-in packages for the same reason; this
// one does the minimum of that: one package, registered through its own frame.
import fs from "node:fs";

const FIXTURE = path.join(os.tmpdir(), "dsh-tool-gate-provider-owned-fixtures");
const PKG_DIR = path.join(FIXTURE, "node_modules", "demo-plugin");

fs.mkdirSync(PKG_DIR, { recursive: true });
fs.writeFileSync(
  path.join(PKG_DIR, "package.json"),
  JSON.stringify({ name: "demo-plugin", version: "1.0.0", type: "module", private: true }, null, 2),
);
fs.writeFileSync(
  path.join(FIXTURE, "package.json"),
  JSON.stringify({ name: "fixture-profile", private: true, dsh: { profile: { bundles: ["demo-plugin"] } } }, null, 2),
);
fs.writeFileSync(
  path.join(PKG_DIR, "index.js"),
  ["export function register(tools, definition) {", "  return tools.register(definition);", "}", ""].join("\n"),
);

const fixture = await import(pathToFileURL(path.join(PKG_DIR, "index.js")).href);

/**
 * The definition shape the fakes use.
 *
 * Plain objects rather than `defineTool(...)`: this suite is about the plugin's
 * contract with the host, and every other suite registers plain objects too — the
 * real factory would only add a parameter-schema compilation step that no
 * assertion here depends on.
 */
const make = (name) => ({
  name,
  description: `${name} demo tool`,
  parameters: { type: "object", additionalProperties: true },
  output: { schema: { type: "json" }, render: (_args, value) => value?.content ?? [] },
  async execute() {
    return { content: [{ type: "text", text: `${name} ran` }] };
  },
});

// ————————————————————————————————————————————————————————————————
// Run
// ————————————————————————————————————————————————————————————————
const host = createHost();

const config = Config({ enabled: true, autoFamilies: true, builtinFamilies: false, diskScan: "off" });
plugin.apply(host.ctx, config);

// Registered *after* the plugin mounts: ownership is then recorded live from the
// caller, which is the case a running host is normally in. Registration before
// the mount is the `preexisting` path and needs the on-disk bundle scan to
// attribute, which `diskScan: "off"` deliberately disables here.
for (const name of ["demo_one", "demo_two", "demo_three"]) {
  fixture.register(host.toolsService, make(name));
}
// A resident tool: no family, so it must stay on the wire either way.
host.toolsService.register(make("resident_tool"));

const agent = host.makeAgent("s1");

// 1. The shape that made the bug invisible: view().visible is a Map.
{
  const view = host.toolsService.view(agent);
  assert.equal(view.visible instanceof Map, true, "0.2.2 shape: visible must be a Map");
  const entries = [...view.visible];
  assert.equal(typeof entries[0], "object", "iterating a Map yields pairs — the trap the plugin fell into");
}

// 2. The plugin must recognise the family and register its gateway.
await host.assemble(agent);
assert.equal(host.definitions.has("demo_plugin"), true, "gateway registered on the 0.2.2 contract");

// 3. The provider's list must lose the members and keep the gateway.
const wireBefore = host.wire(agent);
assert.equal(wireBefore.includes("demo_one"), false, "collapsed member is not on the wire");
assert.equal(wireBefore.includes("demo_plugin"), true, "its gateway is on the wire");
assert.equal(wireBefore.includes("resident_tool"), true, "unowned tools stay");

// 4. The registry still sees every member, which is what `list` reads.
const schemas = host.toolsService.schemas(agent).map((schema) => schema.name);
assert.equal(schemas.includes("demo_one"), true, "members stay callable in the registry");

// 5. `action: "list"` returns the member definitions.
{
  const exec = { callId: "c1", agent, signal: undefined, deferContext() {}, concludeTurn() {} };
  const list = await host.definitions.get("demo_plugin").execute({ action: "list" }, exec);
  const text = list.content.map((block) => block.text).join("\n");
  assert.match(text, /demo_one/, "list shows members");
  assert.match(text, /parameters/, "listDetail includes parameters");
}

// 6. `action: "call"` dispatches through the 0.2.2 batch shape.
{
  const exec = { callId: "c2", rootCallId: "c2", agent, signal: undefined, deferContext() {}, concludeTurn() {} };
  const call = await host.definitions.get("demo_plugin").execute(
    { action: "call", tool: "demo_one", arguments: {} },
    exec,
  );
  const text = call.content.map((block) => block.text).join("\n");
  assert.match(text, /demo_one ran/, "member executed through the gateway");
}

// 7. Freezing: a second assembly must not move the wire bytes.
{
  const first = host.wire(agent).join(",");
  await host.assemble(agent);
  assert.equal(host.wire(agent).join(","), first, "wire is byte-stable across assemblies");
}

// 8. Disabling must give the tools back.
{
  config.enabled = false;
  await host.assemble(agent);
  assert.equal(host.wire(agent).includes("demo_one"), true, "disable restores the members");
}

console.log("ALL PROVIDER-OWNED CHECKS PASSED");
