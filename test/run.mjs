import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
// Tests live in <package>/test, so the package under test is one level up.
const PKG = path.dirname(HERE);
const at = (relative) => pathToFileURL(path.join(PKG, relative)).href;

const { Config } = await import(at("lib/config.js"));
const fam = await import(at("lib/families.js"));
const { createStateStore } = await import(at("lib/state.js"));
const { createGateway } = await import(at("lib/gateways.js"));
const { readGateRecord, agentRowOf, configureSessionApi } = await import(at("lib/state.js"));

/** The Loader hands volatile fields as getters; this is what `index.js` does. */
const plain = (config) => {
  const out = {};
  for (const [key, value] of Object.entries(config)) {
    out[key] = value !== null && typeof value === "object" && typeof value.get === "function" ? value.get() : value;
  }
  return out;
};

// ——— 1. Config is a live settings form —————————————————————————————
const defaults = plain(Config({}));
assert.equal(defaults.enabled, false, "enabled defaults to false");
assert.equal(defaults.listDetail, true);
assert.equal(defaults.staticNotice, true);
assert.equal(defaults.guardFallback, true);
assert.equal(defaults.concurrencyDelegate, false);
assert.equal(defaults.interceptDirectCalls, true);
assert.equal(defaults.unknownOwnerPolicy, "expose");
assert.equal(defaults.ptcMode, "disable");
assert.equal(defaults.freeze, true);
assert.deepEqual(defaults.families, {});
assert.deepEqual(defaults.alwaysExpose, []);
assert.deepEqual(defaults.alwaysHide, []);
assert.equal(defaults.gatewayPrefix, "");

// every field the settings page needs must be volatile (else it is not editable)
const schemaJson = Config.toJSON();
const schemaText = JSON.stringify(schemaJson);
for (const field of [
  "enabled", "concurrencyDelegate", "listDetail", "staticNotice", "guardFallback",
  "interceptDirectCalls", "families", "unknownOwnerPolicy", "alwaysExpose",
  "alwaysHide", "gatewayPrefix", "ptcMode", "freeze", "builtinFamilies",
  "promptDisclosure", "promptPlugins",
]) {
  assert.ok(schemaText.includes(`"${field}"`), `config schema is missing ${field}`);
}
const volatileCount = (schemaText.match(/"volatile":true/g) ?? []).length;
assert.ok(volatileCount >= 12, `expected >=12 volatile fields, saw ${volatileCount}`);
assert.ok(schemaText.includes("总开关"), "descriptions must survive into the schema");
console.log("OK config —", volatileCount, "volatile fields");

// ——— 2. Family discovery & frozen surface ————————————————————————
// Membership is DERIVED from the registry: one package is one family. Nothing
// here enumerates a plugin, which is the whole point — a plugin installed after
// this file was written still collapses.
const owners = {
  blender_rt_do: "dsh-blender-plugin",
  gh_repo: "@perrylink/dsh-github",
  generate_image: "dsh-image-gen",
  mcp__x__y: "mcp:server",
  session_search: "@deepseek-ai/dsh-tool-session-query",
  schedule_create: "@deepseek-ai/dsh-tool-schedule",
  mystery_tool: "some-future-plugin",
};
const families = fam.resolveFamilies({}, { owners });
assert.deepEqual(Object.keys(families).sort(), [
  "blender_plugin", "github", "image_gen", "mcp_servers", "schedule", "session_query",
  "some_future_plugin",
]);
assert.deepEqual(families.mcp_servers.prefixes, ["mcp__"]);
assert.equal(families.session_query.builtin, true, "first-party packages are builtin");
assert.equal(families.blender_plugin.builtin, false, "third-party packages are not");
assert.equal(families.session_query.gateway, "session", "a label hint may shorten the gateway name");
// The group switch gates every first-party family independently of its own switch.
assert.equal(fam.resolveFamilies({}, { owners, builtinEnabled: false }).session_query, undefined);
assert.equal(fam.resolveFamilies({}, { owners, builtinEnabled: false }).blender_plugin.enabled, true);
assert.equal(fam.resolveFamilies({ session_query: { enabled: false } }, { owners }).session_query.enabled, false);
assert.equal(fam.resolveFamilies({ session_query: { enabled: false } }, { owners }).schedule.enabled, true);
// autoFamilies: false derives nothing at all.
assert.deepEqual(Object.keys(fam.resolveFamilies({}, { owners, auto: false })), []);
// Builtin members are no longer unconditionally resident.
assert.equal(fam.isKeepTool("session_search"), false, "session_search is collapsible");
assert.equal(fam.isKeepTool("schedule_create"), false, "schedule_create is collapsible");
assert.equal(fam.isKeepTool("workflow"), true, "but the rest of core still stays");

const ownerOf = (name) => owners[name];
const gatewayFor = (id) => families[id]?.gateway ?? id;
const resolver = fam.createFamilyResolver(families, ownerOf, gatewayFor);
assert.equal(resolver.familyOf("blender_rt_do"), "blender_plugin");
assert.equal(resolver.familyOf("mcp__x__y"), "mcp_servers");
assert.equal(resolver.familyOf("gh_repo"), "github");
assert.equal(resolver.familyOf("generate_image"), "image_gen");
assert.equal(resolver.familyOf("mystery_tool"), "some_future_plugin", "an unseen plugin collapses with zero config");
assert.equal(resolver.familyOf("workflow"), undefined);
assert.equal(resolver.familyOf("blender_plugin"), undefined, "gateway names are never members");

const tools = [
  { name: "workflow", description: "x", parameters: {} },
  { name: "ops_bash", description: "x", parameters: {} },
  { name: "compress", description: "x", parameters: {} },
  { name: "blender_rt_do", description: "x", parameters: {} },
  { name: "gh_repo", description: "x", parameters: {} },
  { name: "generate_image", description: "x", parameters: {} },
  { name: "mcp__x__y", description: "x", parameters: {} },
  { name: "session_search", description: "x", parameters: {} },
  { name: "unknown_tool", description: "x", parameters: {} },
  { name: "blender", description: "gateway", parameters: {} },
  { name: "blender_plugin", description: "gateway", parameters: {} },
];
const surface = (extra = {}) => fam.buildFrozenSurface(tools, {
  familyOf: resolver.familyOf,
  families,
  alwaysExpose: [],
  alwaysHide: [],
  unknownOwnerPolicy: "expose",
  keepNames: new Set(["blender", "blender_plugin"]),
  ...extra,
});

const built = surface();
assert.deepEqual(
  built.tools.map((t) => t.name),
  ["blender", "blender_plugin", "compress", "ops_bash", "unknown_tool", "workflow"],
  "resident + gateways + unknown-owner stay; every family member collapses",
);
assert.deepEqual(
  [...built.collapsed].sort(),
  ["blender_rt_do", "generate_image", "gh_repo", "mcp__x__y", "session_search"],
);
assert.equal(JSON.stringify(surface().tools), JSON.stringify(built.tools), "surface is byte-stable");

const collapsedUnknown = surface({ unknownOwnerPolicy: "collapse" });
assert.ok(collapsedUnknown.collapsed.includes("unknown_tool"));
assert.ok(!collapsedUnknown.tools.some((t) => t.name === "unknown_tool"));

const forced = surface({ alwaysExpose: ["gh_repo"], alwaysHide: ["workflow"] });
assert.ok(forced.tools.some((t) => t.name === "gh_repo"), "alwaysExpose wins");
assert.ok(!forced.tools.some((t) => t.name === "workflow"), "alwaysHide wins");

const gatedFamilies = fam.resolveFamilies({ blender_plugin: { enabled: false } }, { owners });
const withDisabled = fam.buildFrozenSurface(tools, {
  familyOf: fam.createFamilyResolver(
    gatedFamilies,
    ownerOf,
    (id) => gatedFamilies[id]?.gateway ?? id,
  ).familyOf,
  families: gatedFamilies,
  alwaysExpose: [],
  alwaysHide: [],
  unknownOwnerPolicy: "expose",
  keepNames: new Set(["blender", "blender_plugin"]),
});
assert.ok(withDisabled.tools.some((t) => t.name === "blender_rt_do"), "disabled family is not collapsed");
console.log("OK families");

// ——— 3. Gateway definition compiles under defineTool —————————————
const states = createStateStore();
const registry = [];
const members = [];
const ctx = {
  tools: {
    register: (definition) => {
      registry.push(definition);
      return () => {};
    },
    get: (name) => members.find((entry) => entry.name === name),
    schemas: () => members.map((entry) => ({
      name: entry.name,
      description: entry.description,
      parameters: entry.parameters,
    })),
    execute: async (input) => {
      const found = members.find((entry) => entry.name === input.name);
      if (found === undefined) return { isError: true, error: { message: "unknown" }, content: [] };
      return found.execute(input.arguments, { ...input, deferContext() {}, concludeTurn() {} });
    },
  },
  logger: { debug() {}, warn() {}, info() {} },
};
const runtime = {
  ctx,
  logger: ctx.logger,
  config: () => plain(Config({ enabled: true })),
  families: () => families,
  stateFor: (agent) => states.ensure(agent),
  familyOf: (name) => resolver.familyOf(name),
  gatewayNameFor: (id) => fam.gatewayName("", id, families[id]?.gateway),
  labelFor: (id) => families[id]?.label || id,
};

const gateway = createGateway({ family: families.blender_plugin, name: "blender", runtime });
assert.equal(gateway.name, "blender");
assert.equal(typeof gateway.execute, "function");
assert.equal(typeof gateway.output.render, "function");
const params = gateway.parameters;
assert.equal(params.type, "object");
assert.deepEqual(params.required, ["action"]);
assert.deepEqual(params.properties.action.enum, ["list", "call"]);
assert.equal(params.properties.arguments.additionalProperties, true);
assert.equal(
  JSON.stringify(params).includes("blender_rt_do"),
  false,
  "the wire schema must not embed member names",
);
console.log("gateway parameters:", JSON.stringify(params));
console.log("OK gateway");

// ——— 4. list / call through the gateway ——————————————————————————
members.push({
  name: "blender_rt_do",
  description: "run python in Blender",
  parameters: { type: "object", additionalProperties: true },
  execute: async () => ({ content: [{ type: "text", text: "done" }] }),
});

const agent = { id: "agent-1" };
const list = await gateway.execute({ action: "list" }, { callId: "c1", agent });
const listText = list.content.map((block) => block.text).join("\n");
assert.match(listText, /blender_rt_do/, "list must name the member");
assert.match(listText, /parameters/, "listDetail=true must include the parameter schema");

const second = await gateway.execute({ action: "list" }, { callId: "c2", agent });
assert.match(second.content[0].text, /已在本会话中返回过/, "second list is a reminder only");

const call = await gateway.execute(
  { action: "call", tool: "blender_rt_do", arguments: { code: "1+1" } },
  { callId: "c3", agent },
);
assert.deepEqual(call.content, [{ type: "text", text: "done" }], "call returns the member's content");

// `workflow` is a real tool that belongs to no family: calling it through a
// gateway must redirect rather than dispatch.
members.push({
  name: "workflow",
  description: "run a workflow",
  parameters: { type: "object", additionalProperties: true },
  execute: async () => ({ content: [{ type: "text", text: "should not run" }] }),
});

const wrongFamily = await gateway.execute({ action: "call", tool: "workflow" }, { callId: "c4", agent });
assert.match(wrongFamily.content[0].text, /不属于任何网关家族/, "unowned tool gets a redirect");

const unknownTool = await gateway.execute({ action: "call", tool: "nope" }, { callId: "c5", agent });
assert.match(unknownTool.content[0].text, /未知工具/);
console.log("OK dispatch");

// ——— 5. Per-agent state isolation ————————————————————————————————
const a = states.ensure({ id: "a" });
const b = states.ensure({ id: "b" });
a.adopt([{ name: "x" }], ["collapsed-a"]);
assert.equal(b.frozen, undefined, "agents never share a frozen surface");
assert.equal(a.collapsedNames.has("collapsed-a"), true);
assert.equal(b.collapsedNames.has("collapsed-a"), false);
assert.equal(a.nextCallId("p"), "p:gw:1");
assert.equal(a.nextCallId("p"), "p:gw:2");
console.log("OK state isolation");

// ——— 6. Gate record round-trips through the session log ——————————
const written = [];
configureSessionApi({
  appendPluginRecord: (session, type, data) => {
    written.push({ type, data, ignorable: true });
  },
  pluginRecordOf: (event) =>
    event !== undefined && event.ignorable === true && typeof event.type === "string"
      ? { type: event.type, data: event.data }
      : undefined,
});
const { writeGateRecord } = await import(at("lib/state.js"));
const session = { log: [] };
assert.equal(writeGateRecord(session, a, ["a", "b"], undefined), true);
session.log.push({ ...written[0] });
const record = readGateRecord(session);
assert.equal(record.schemaVersion, 1);
const row = agentRowOf(record, "a");
assert.deepEqual(row.names, ["a", "b"]);
assert.deepEqual(row.collapsed, ["collapsed-a"]);
assert.equal(agentRowOf(record, "zzz"), undefined);
console.log("OK gate record");

// ——— framework packages are infrastructure, not plugins ———————————————
// `@deepseek-ai/cordis` is the DI framework itself: a tool registered from inside
// one of its effects walks through framework frames, so the nearest package.json
// can be the framework. Treating that as an owner invents a family named after the
// framework and fills it with tools that are on the wire unconditionally — a
// gateway with nothing behind it. `owner.js` skips those frames while walking.
{
  const { deriveFamilies } = await import(at("lib/discovery.js"));
  const families = deriveFamilies({
    owners: {
      ask_user_question: "@deepseek-ai/cordis",
      todo_write: "@deepseek-ai/cordis",
      cordis_inspect_list: "@deepseek-ai/dsh-tool-cordis",
      some_optional_tool: "dsh-real-plugin",
    },
  });
  assert.equal(
    families.cordis,
    undefined,
    "a package whose tools are all resident defines no family, hence no empty gateway",
  );
  assert.ok(
    Object.values(families).some((family) => family.packages.includes("dsh-real-plugin")),
    "a package that owns an optional tool still becomes a family",
  );
  console.log("OK framework packages do not become families");
}


console.log("\nALL CHECKS PASSED");
