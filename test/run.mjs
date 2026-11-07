import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
// Tests live in <package>/test, so the package under test is one level up.
const PKG = path.dirname(HERE);
const at = (relative) => pathToFileURL(path.join(PKG, relative)).href;

const { Config } = await import(at("lib/config.js"));
const fam = await import(at("lib/families.js"));
const { createStateStore } = await import(at("lib/state.js"));
const { createGateway, reconcileGateways } = await import(at("lib/gateways.js"));
const { readGateRecord, agentRowOf, configureSessionApi, RECORD_STATE } = await import(at("lib/state.js"));

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
// No family carries a short gateway name any more: the wire name *is* the family
// id, so `session_query` and `session_query2` cannot collide in one namespace and
// the roster always matches the page.
assert.equal(families.session_query.gateway, undefined, "the gateway name is the family id");
assert.equal(families.session_query.label, "Session Query", "the label comes from the package name");
// The group switch gates every first-party family independently of its own switch.
assert.equal(fam.resolveFamilies({}, { owners, builtinEnabled: false }).session_query, undefined);
assert.equal(fam.resolveFamilies({}, { owners, builtinEnabled: false }).blender_plugin.enabled, true);
assert.equal(fam.resolveFamilies({ session_query: { enabled: false } }, { owners }).session_query.enabled, false);
assert.equal(fam.resolveFamilies({ session_query: { enabled: false } }, { owners }).schedule.enabled, true);
// autoFamilies: false derives nothing at all.
assert.deepEqual(Object.keys(fam.resolveFamilies({}, { owners, auto: false })), []);

// ——— descriptions come from the host, not from a table in here ————————
// A plugin's own metadata wins over the fallback table, and the family records
// which layer answered so the settings page can show it.
{
  const withMeta = fam.resolveFamilies({}, {
    owners,
    metadata: (pkg) => (pkg === "@perrylink/dsh-github"
      ? { text: "GitHub PRs, reviews and CI", source: "metaOf" }
      : { text: "", source: "none" }),
  });
  assert.equal(withMeta.github.description, "GitHub PRs, reviews and CI", "the host's text replaces the table row");
  assert.equal(withMeta.github.descriptionSource, "metaOf", "and the family records which layer answered");
  // There is no fallback table any more: a package the host cannot describe
  // carries an empty description and says so, rather than an invented sentence
  // that can drift away from the package.
  assert.equal(withMeta.blender_plugin.description, "");
  assert.equal(withMeta.blender_plugin.descriptionSource, "none");
  // An id with nothing anywhere is honestly empty rather than invented.
  assert.equal(withMeta.some_future_plugin.description, "");
  assert.equal(withMeta.some_future_plugin.descriptionSource, "none");

  // A configured description outranks both, and says so.
  const overridden = fam.resolveFamilies(
    { github: { description: "覆盖" } },
    { owners, metadata: () => ({ text: "X", source: "metaOf" }) },
  );
  assert.equal(overridden.github.description, "覆盖", "the user's description wins");
  assert.equal(overridden.github.descriptionSource, "override");

  // Without a metadata reader there is nothing to show, and nothing is invented.
  assert.equal(fam.resolveFamilies({}, { owners }).github.description, "");
  assert.equal(fam.resolveFamilies({}, { owners }).github.descriptionSource, "none");

  // The label is derived from the package name — `some-future-plugin` was never in
  // any table, and it still reads properly.
  assert.equal(fam.resolveFamilies({}, { owners }).some_future_plugin.label, "Some Future Plugin");
  assert.equal(fam.resolveFamilies({}, { owners }).blender_plugin.label, "Blender Plugin");
  assert.equal(fam.resolveFamilies({}, { owners }).github.label, "Github", "the package name, capitalised — not the brand");
  assert.equal(
    fam.resolveFamilies({}, { owners, metadata: () => ({ title: "文件读写工具" }) }).fs?.label,
    undefined,
    "no family is invented for a package with no tools",
  );
  const withFs = fam.resolveFamilies({}, { owners: { read_file: "@deepseek-ai/dsh-tool-fs" }, metadata: () => ({ title: "文件读写工具" }) });
  assert.equal(withFs.fs.label, "FS", "acronyms stay upper-case; the host's title does not participate");
  // The host's localized title is what turned `Hindsight` into the capability word
  // `记忆`, so it is not a label source at all any more. The override is the way
  // back to a brand capitalisation: `families.github.label: GitHub`.
  const branded = fam.resolveFamilies({ github: { label: "GitHub" } }, { owners });
  assert.equal(branded.github.label, "GitHub", "a configured label still wins");
  console.log("OK description sources");
}
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

const gateway = createGateway({ family: families.blender_plugin, name: "blender_plugin", runtime });
assert.equal(gateway.name, "blender_plugin");
assert.equal(typeof gateway.execute, "function");
assert.equal(typeof gateway.output.render, "function");
// The usage contract belongs to the system-prompt notice, said once — not to
// every gateway, which is where it used to be repeated 12 times.
assert.equal(
  gateway.description.includes("这个家族的成员工具不在本轮工具列表里"),
  false,
  "the gateway description carries no shared boilerplate",
);
assert.match(gateway.description, /^网关 · Blender Plugin/, "it names the family in one line");
// With no description from the host there is no colon and no invented sentence.
assert.equal(gateway.description, "网关 · Blender Plugin", "an undescribed family still gets a usable line");
// No length ceiling: the description is whatever the plugin says about itself.
// A fixed column used to cut the longest ones mid-clause, and the clause it cut
// was the one saying what the plugin is *for*.
{
  const long = "x".repeat(400);
  const longGateway = createGateway({
    family: { id: "long", label: "Long", description: long },
    name: "long",
    runtime,
  });
  assert.ok(longGateway.description.includes(long), "the whole description is kept");
}
// With the notice switched off, nothing else tells the model this tool is a
// gateway, so the description has to say so itself.
const selfExplaining = createGateway({
  family: families.blender_plugin,
  name: "blender_plugin",
  runtime: { ...runtime, config: () => plain(Config({ enabled: true, staticNotice: false })) },
});
assert.match(selfExplaining.description, /action="list"/, "self-explaining when no notice is present");
assert.match(selfExplaining.description, /action="call"/);
// A family with nothing to say still gets a usable one-liner.
const bare = createGateway({ family: { id: "x", label: "X" }, name: "x", runtime });
assert.equal(bare.description, "网关 · X", "an empty description still names the family");
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

// ——— 3b. A family with no members gets no gateway ————————————————
// A config-declared family naming a package that registers nothing would
// otherwise put a tool on the wire whose `list` can only answer "no members".
{
  const mounted = new Map();
  const unscannable = new Set();
  const registered = [];
  const fakeCtx = {
    tools: {
      register: (definition) => {
        registered.push(definition.name);
        return () => {};
      },
    },
  };
  const table = {
    real: { id: "real", packages: ["@acme/real"], tools: [], prefixes: [], enabled: true },
    ghost: { id: "ghost", packages: ["@acme/ghost"], tools: [], prefixes: [], enabled: true },
  };
  const names = reconcileGateways({
    ctx: fakeCtx,
    families: table,
    gatewayNameFor: (id) => `gw${id}`,
    runtime,
    logger: ctx.logger,
    mounted,
    unscannable,
    emptyFamilies: new Set(["ghost"]),
  });
  assert.deepEqual(names, ["gwreal"], "only the populated family gets a gateway");
  assert.equal(scannableHas(unscannable, "gwghost"), false, "the empty family's name is never tracked");

  // Disposing the ghost family (it becomes populated) must mount it.
  const names2 = reconcileGateways({
    ctx: fakeCtx,
    families: table,
    gatewayNameFor: (id) => `gw${id}`,
    runtime,
    logger: ctx.logger,
    mounted,
    unscannable,
    emptyFamilies: new Set(),
  });
  assert.deepEqual(names2, ["gwghost", "gwreal"], "a family that gains members gains its gateway");
  assert.equal(scannableHas(unscannable, "gwghost"), true, "and its name becomes unscannable again");

  function scannableHas(set, name) {
    return set.has(name);
  }
  console.log("OK empty families get no gateway");
}

// ——— 3c. A gateway is rebuilt when its own description bytes change ————
// Names alone are not enough: a plugin upgrade rewrites a family's description,
// and `staticNotice` flipping changes whether the description must explain
// itself. Leaving the old registration in place would show the model stale text
// for the rest of the session, because the wire surface is frozen.
{
  const mounted = new Map();
  const unscannable = new Set();
  let disposals = 0;
  const table = {
    real: { id: "real", label: "Real", description: "first", tools: [], prefixes: [], packages: ["@acme/real"], enabled: true },
  };
  const fakeCtx = {
    tools: {
      register: () => () => { disposals += 1; },
    },
  };
  const reconcile = (familiesTable, staticNotice) => reconcileGateways({
    ctx: fakeCtx,
    families: familiesTable,
    gatewayNameFor: (id) => `gw${id}`,
    runtime: { ...runtime, config: () => ({ ...plain(Config({ enabled: true })), staticNotice }) },
    logger: ctx.logger,
    mounted,
    unscannable,
    emptyFamilies: new Set(),
  });

  assert.deepEqual(reconcile(table, true), ["gwreal"]);
  assert.equal(disposals, 0, "an unchanged family is not re-registered");
  assert.deepEqual(reconcile(table, true), ["gwreal"]);
  assert.equal(disposals, 0, "and stays put across repeated reconciles");

  // A plugin upgrade: same name, new bytes.
  const upgraded = { real: { ...table.real, description: "second" } };
  assert.deepEqual(reconcile(upgraded, true), ["gwreal"]);
  assert.equal(disposals, 1, "a changed description disposes the old registration");
  assert.deepEqual(reconcile(upgraded, true), ["gwreal"]);
  assert.equal(disposals, 1, "and then settles");

  // Turning the notice off makes every description self-explaining.
  assert.deepEqual(reconcile(upgraded, false), ["gwreal"]);
  assert.equal(disposals, 2, "staticNotice is part of what a gateway's bytes depend on");
  console.log("OK gateway rebuilds on description change");
}

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
assert.equal(record.schemaVersion, 2);
const row = agentRowOf(record, "a");
assert.deepEqual(row.names, ["a", "b"]);
assert.deepEqual(row.collapsed, ["collapsed-a"]);
assert.equal(agentRowOf(record, "zzz"), undefined);

// A session resumed across the upgrade still holds a v1 record. Its agent-row
// shape is unchanged, so it must be read rather than discarded — refusing would
// silently un-collapse every family in that session.
{
  const legacy = {
    log: [{ ignorable: true, type: RECORD_STATE, data: { schemaVersion: 1, agents: [{ id: "a", names: [], collapsed: ["c"], createdAt: 0 }] } }],
  };
  const old = readGateRecord(legacy);
  assert.equal(old?.schemaVersion, 1, "a v1 record is still readable");
  assert.deepEqual(agentRowOf(old, "a")?.collapsed, ["c"]);
  // An unreadable future version is ignored rather than half-interpreted.
  const future = { log: [{ ignorable: true, type: RECORD_STATE, data: { schemaVersion: 0, agents: [] } }] };
  assert.equal(readGateRecord(future), undefined, "a pre-v1 record is rejected");
}
console.log("OK gate record");

// ——— prompt switches are folded onto their families ————————————————————
// A profile written before the merge has one switch per package. The page now
// renders one switch per family, so those entries must be rewritten once, and
// only the family flag consulted afterwards — otherwise turning the merged switch
// off would clear one source of truth while another kept it on.
{
  const { migratePromptPlugins } = await import(at("lib/migrate.js"));
  /** A config field shaped like the Loader's volatile reference. */
  const ref = (initial) => {
    let current = initial;
    const symbol = Object.getOwnPropertySymbols({ [Symbol.for("cosmokit.volatile.write")]: 1 })
      .find((entry) => String(entry).includes("cosmokit.volatile.write"));
    return Object.freeze({ get: () => current, [symbol]: (next) => { current = next; } });
  };

  const config = {
    promptPlugins: ref({
      "dsh-free-search": { enabled: true },
      "dsh-image-gen": { enabled: true },
      "dsh-ghost": { enabled: true },
    }),
    families: ref({}),
  };
  const families = {
    free_search: { id: "free_search", packages: ["dsh-free-search"] },
    image_gen: { id: "image_gen", packages: ["dsh-image-gen"] },
  };

  const result = migratePromptPlugins({ config, families });
  assert.equal(result.migrated, true, "an enabled v1 switch is migrated");
  assert.deepEqual(result.moved.sort(), ["free_search", "image_gen"], "onto the families that own the packages");
  assert.deepEqual(result.dropped, ["dsh-ghost"], "a package with no family is dropped, not invented");
  assert.equal(config.families.get().free_search.promptDisclosure, true, "the family flag is written");
  assert.equal(config.families.get().image_gen.promptDisclosure, true);
  assert.equal(
    config.promptPlugins.get()["dsh-free-search"].enabled,
    false,
    "and the legacy switch is cleared so only one source of truth survives",
  );

  // Idempotent: a second run finds nothing enabled and changes nothing.
  const again = migratePromptPlugins({ config, families });
  assert.equal(again.migrated, false, "a migrated config is left alone");
  assert.deepEqual(again.moved, []);
  assert.deepEqual(again.dropped, [], "and does not re-report the dropped package");

  // A config with no legacy switches is untouched.
  const clean = { promptPlugins: ref({}), families: ref({}) };
  assert.equal(migratePromptPlugins({ config: clean, families }).migrated, false, "nothing to do");
  console.log("OK prompt switch migration");
}


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


// ——— ownership comes from the carrier context, not the stack —————————
// Cordis hands a service method a traceable proxy whose `ctx` is the *calling*
// context, and the Loader tags that context with `Symbol.for("cordis.entry")`.
// That symbol is the entire attribution channel; the old code read
// `ctx.fiber.name` (always this plugin) or walked the stack (slow, and wrong
// through framework frames).
{
  const { packageOfContext, callerPackageOf, isHarnessPackage } = await import(at("lib/ownership-channel.js"));
  const ENTRY = Symbol.for("cordis.entry");

  // A plugin context carries the entry; nesting inherits it through the prototype.
  const entry = { options: { name: "@acme/plugin-a" } };
  const pluginCtx = Object.create({ [ENTRY]: entry });
  const nested = Object.create(pluginCtx);
  assert.equal(packageOfContext(pluginCtx), "@acme/plugin-a", "entry tag names the package");
  assert.equal(packageOfContext(nested), "@acme/plugin-a", "a nested context inherits it");
  assert.equal(packageOfContext(Object.create(null)), undefined, "root code has no owner");
  assert.equal(packageOfContext(undefined), undefined);
  assert.equal(packageOfContext(42), undefined);

  // The receiver of a service method is a proxy whose `ctx` is the caller's.
  assert.equal(callerPackageOf({ ctx: pluginCtx }), "@acme/plugin-a");
  assert.equal(callerPackageOf({}), undefined, "a plain object has no context");
  assert.equal(callerPackageOf(null), undefined);
  // A throwing getter must not escape: it runs on the registration path.
  assert.equal(callerPackageOf({ get ctx() { throw new Error("boom"); } }), undefined);

  // One definition of "first party", now that three copies used to disagree.
  assert.equal(isHarnessPackage("@deepseek-ai/dsh-tool-goal"), true);
  assert.equal(isHarnessPackage("@dsh-ops/dsh-ops"), true, "@dsh-ops counts as first party");
  assert.equal(isHarnessPackage("dsh-free-search"), false);
  console.log("OK ownership channel");
}

// ——— the on-disk scan is not on the hot path ————————————————————————
// The scan reads every installed bundle's source. A name no bundle can claim
// would re-trigger it on every call; this plugin's own gateway tools are exactly
// that. They are declared `unscannable` and the scan must not be asked about them.
{
  const { createOwnerIndex } = await import(at("lib/owner.js"));
  const registered = [];
  const tools = {
    register(definition) {
      registered.push(definition.name);
      return () => {};
    },
    layers: { global: { tools: { entries: () => new Map() } }, scoped: new Map() },
  };
  // `ctx.on` returns a disposer; `ctx.effect` runs and remembers the cleanup.
  const ctx = {
    tools,
    on: () => () => {},
    effect: (factory) => factory(),
    get: (name) => (name === "tools" ? tools : undefined),
  };
  const index = createOwnerIndex(ctx, undefined, {
    unscannable: new Set(["blender", "github"]),
    diskScan: false,
  });
  const known = new Set(["blender", "github", "alpha_tool"]);
  const snapshot = index.registered(known);
  assert.equal(snapshot.blender, undefined, "a gateway name is never attributed to a package");
  assert.equal(snapshot.github, undefined);
  index.dispose();

  // `diskScan: false` means an unresolvable name stays unresolved instead of
  // reaching for the filesystem.
  const index2 = createOwnerIndex(ctx, undefined, { diskScan: false });
  assert.deepEqual(index2.registered(new Set(["totally_unknown_tool"])), {});
  index2.dispose();

  // The config field is volatile, so the index takes a *reader*: flipping the
  // switch mid-session must be honoured, not frozen at construction.
  let scanning = false;
  const index3 = createOwnerIndex(ctx, undefined, { diskScan: () => scanning });
  assert.deepEqual(index3.registered(new Set(["still_unknown"])), {});
  scanning = true;
  assert.equal(typeof index3.registered(new Set(["still_unknown"])), "object");
  index3.dispose();
  console.log("OK scan hot path");
}

// ——— the scan index invalidates itself when a plugin is installed ————
// The index used to be keyed on the profile root alone, with a comment claiming
// it "changes only on install" — while nothing on install told it so. A plugin
// enabled by another process therefore stayed invisible until a restart.
{
  const os = await import("node:os");
  const { scanForOwners } = await import(at("lib/tool-scan.js"));
  const NL = String.fromCharCode(10);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-gate-scan-"));
  const writeBundle = (specifier, toolName) => {
    const dir = path.join(root, "node_modules", specifier);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: specifier }));
    fs.writeFileSync(path.join(dir, "tools.js"),
      `export const definitions = [${NL}  { name: "${toolName}" },${NL}];${NL}`);
  };
  const manifest = (bundles) => {
    fs.writeFileSync(path.join(root, "package.json"),
      JSON.stringify({ name: "probe-profile", dsh: { profile: { bundles } } }));
  };

  writeBundle("dsh-first", "alpha_tool");
  manifest(["dsh-first"]);
  // A fresh root is always read: its stamp has never been seen.
  assert.deepEqual(scanForOwners(new Set(["alpha_tool"]), undefined, root), { alpha_tool: "dsh-first" });
  // A name no bundle claims is answered from the cached plan — no second read.
  assert.deepEqual(scanForOwners(new Set(["beta_tool"]), undefined, root), {});

  // Installing a bundle rewrites the profile manifest (it *is* the bundle list),
  // which moves the stamp — so the index rebuilds itself with no help from anyone.
  writeBundle("dsh-second", "beta_tool");
  manifest(["dsh-first", "dsh-second"]);
  assert.deepEqual(scanForOwners(new Set(["beta_tool"]), undefined, root), { beta_tool: "dsh-second" },
    "a newly installed bundle is visible without forgetScanCache()");
  assert.deepEqual(scanForOwners(new Set(["alpha_tool"]), undefined, root), { alpha_tool: "dsh-first" },
    "and the old one is still placed");

  fs.rmSync(root, { recursive: true, force: true });
  console.log("OK scan index self-invalidates");
}

// ——— ownerIndex.forget(): drop the disk-derived answer, keep the live facts ——
// `registered()` memoizes on a revision counter that only moves when *this
// process* observes a change. The scan fingerprint (see above) already catches
// the common case — a bundle installed by another process rewrites the profile
// manifest. `forget()` is the explicit escape hatch for everything the stamp
// cannot see (a same-size rewrite inside one mtime tick, a package swapped in
// place), and it is what POST /refresh calls.
{
  const os = await import("node:os");
  const { createOwnerIndex, UNKNOWN } = await import(at("lib/owner.js"));
  const { forgetScanCache } = await import(at("lib/tool-scan.js"));
  const NL = String.fromCharCode(10);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-gate-forget-"));
  const bundle = (specifier, toolName) => {
    const dir = path.join(root, "node_modules", specifier);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: specifier }));
    fs.writeFileSync(path.join(dir, "tools.js"), `export const definitions = [${NL}  { name: "${toolName}" },${NL}];${NL}`);
  };
  const writeProfile = (bundles) => {
    fs.writeFileSync(path.join(root, "package.json"),
      JSON.stringify({ name: "probe-profile", dsh: { profile: { bundles } } }));
  };
  const previousProfile = process.env.DSH_PROFILE_DIR;
  process.env.DSH_PROFILE_DIR = root;
  try {
    bundle("dsh-first", "alpha_tool");
    writeProfile(["dsh-first"]);

    const tools = {
      register: () => () => {},
      layers: { global: { tools: { entries: () => new Map() } }, scoped: new Map() },
    };
    const ctx = {
      tools,
      on: () => () => {},
      effect: (factory) => factory(),
      get: (name) => (name === "tools" ? tools : undefined),
    };
    const index = createOwnerIndex(ctx, undefined, { diskScan: true });
    const first = index.registered(new Set(["alpha_tool", "ghost_tool"]));
    assert.deepEqual(first, { alpha_tool: "dsh-first" }, "a scanned owner is learned");
    // The memo key carries the revision, and a scan that *learns* something bumps
    // it — so the second identical call re-derives once and is cached from then on.
    const second = index.registered(new Set(["alpha_tool", "ghost_tool"]));
    assert.deepEqual(second, first);
    assert.equal(index.registered(new Set(["alpha_tool", "ghost_tool"])), second,
      "an unchanged query is memoized, not rescanned");

    // A second plugin arrives while this process runs. The manifest moves, so the
    // scan index rebuilds itself and `registered()` already sees it — no forget().
    bundle("dsh-second", "beta_tool");
    writeProfile(["dsh-first", "dsh-second"]);
    assert.deepEqual(index.registered(new Set(["beta_tool"])), { beta_tool: "dsh-second" },
      "an install from another process is picked up by the manifest fingerprint alone");

    // `forget()` is still the escape hatch for what a stamp cannot see: it drops
    // the memoized answer and forces the next call back through the scan.
    const scans = new Set(["alpha_tool", "beta_tool"]);
    index.forget();
    assert.deepEqual(index.registered(new Set(["alpha_tool", "beta_tool"])),
      { alpha_tool: "dsh-first", beta_tool: "dsh-second" },
      "and forget() re-derives the same answers");
    index.forget();
    assert.deepEqual(index.registered(scans), { alpha_tool: "dsh-first", beta_tool: "dsh-second" },
      "calling it twice is harmless");

    // What it must NOT clear: the ownership learned from live registrations, and
    // the names that were already present at mount. Those are facts about this
    // process, not a cache of the filesystem.
    assert.equal(index.ownerOf("alpha_tool"), "dsh-first", "scanned ownership survives");
    index.dispose();
  } finally {
    if (previousProfile === undefined) delete process.env.DSH_PROFILE_DIR;
    else process.env.DSH_PROFILE_DIR = previousProfile;
    forgetScanCache();
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log("OK owner forget");
}

// ——— the label is derived from the package name, never from a table ————
{
  const { rawLabelOf } = await import(at("lib/family-labels.js"));
  const cases = {
    "dsh-blender-plugin": "Blender Plugin",
    "@perrylink/dsh-github": "Github",
    "@deepseek-ai/dsh-tool-session-query": "Session Query",
    "@deepseek-ai/dsh-tool-fs": "FS",
    "dsh-tool-fs-search": "FS Search",
    "@vectorize-io/hindsight-coding-agents": "Hindsight Coding Agents",
    "dsh-image-gen": "Image Gen",
    "dsh-mcp-connector": "MCP Connector",
    "@deepseek-ai/dsh-tool-schedule": "Schedule",
    "dsh-video-storyboard": "Video Storyboard",
    "dsh-free-search": "Free Search",
    "computer_use_win": "Computer Use Win",
    "tavily": "Tavily",
    "mcp_servers": "MCP Servers",
    "acme_widgets": "Acme Widgets",
    "dsh-plugin-thing": "Thing",
    "plugin-thing": "Thing",
    "dsh-tool-http-api": "HTTP API",
  };
  for (const [pkg, expected] of Object.entries(cases)) {
    assert.equal(rawLabelOf(pkg), expected, `rawLabelOf(${pkg})`);
  }
  assert.equal(rawLabelOf(""), "", "nothing to derive answers the input");
  assert.equal(rawLabelOf(undefined), "");
  assert.equal(rawLabelOf("sub/deep"), "Deep", "the last path segment is the name");
  // A prefix is only dropped when something follows it: `dsh` alone is a name.
  assert.equal(rawLabelOf("dsh"), "Dsh");
  console.log("OK label derivation");
}

// ——— summarize: flatten whitespace, keep every sentence ————————————
{
  const { summarize } = await import(at("lib/plugin-meta.js"));
  assert.equal(summarize(""), "");
  assert.equal(summarize("  \n "), "");
  // Every sentence is kept. Picking the first one used to drop the clause that
  // said what the plugin was *for* — the opening sentence is usually the vaguest.
  assert.equal(summarize("第一句。第二句。"), "第一句。第二句。");
  assert.equal(summarize("First sentence. Second one."), "First sentence. Second one.");
  // A version number's period is not a sentence end (nothing looks for one now,
  // and this is the case that must keep working).
  assert.equal(summarize("Blender 插件 v3.0.4 直连"), "Blender 插件 v3.0.4 直连");
  // Whitespace is flattened, so a multi-line description cannot reshape a tool.
  assert.equal(summarize("a\n\nb\tc"), "a b c");
  // Nothing is truncated and nothing is marked: an overlong description arrives
  // whole, with no ellipsis.
  const long = `${"word ".repeat(60)}end`.trim();
  assert.equal(summarize(long), long);
  assert.equal(summarize("🎨".repeat(80)).includes("\uFFFD"), false, "no replacement characters");
  // The optional ceiling exists but is off by default; when asked for, it counts
  // code points so it cannot split a surrogate pair.
  assert.equal(summarize(long, 0), long, "0 means no ceiling");
  const capped = summarize("🎨".repeat(80), 10);
  assert.equal([...capped].length, 11, "10 code points plus the ellipsis");
  assert.ok(capped.endsWith("…"));
  assert.equal(capped.includes("\uFFFD"), false, "no replacement characters from a split pair");
  assert.equal(summarize("字".repeat(120), 120), "字".repeat(120), "the boundary is inclusive");
  assert.ok(summarize("字".repeat(121), 120).endsWith("…"));
  console.log("OK summarize");
}

// ——— barePackageName: one package, one row ——————————————————————————
{
  const { barePackageName } = await import(at("lib/ownership-channel.js"));
  assert.equal(barePackageName("@scope/name/sub/deep"), "@scope/name");
  assert.equal(barePackageName("@scope/name"), "@scope/name");
  assert.equal(barePackageName("pkg/sub"), "pkg");
  assert.equal(barePackageName("pkg"), "pkg");
  assert.equal(barePackageName("./relative.js"), undefined);
  assert.equal(barePackageName("/absolute/path.js"), undefined);
  assert.equal(barePackageName("node:fs"), undefined);
  assert.equal(barePackageName("cordis:framework"), undefined);
  assert.equal(barePackageName(""), undefined);
  assert.equal(barePackageName(undefined), undefined);
  assert.equal(barePackageName("@scope"), undefined, "a scope with no package names nothing");
  console.log("OK barePackageName");
}

console.log("\nALL CHECKS PASSED");
