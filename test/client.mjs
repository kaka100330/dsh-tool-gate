/**
 * Render-level smoke test for lib/client.js without a real React.
 *
 * The browser bundle only runs inside the Web UI, so a typo or a bad hook order
 * would otherwise surface as a blank settings page. This shim provides just
 * enough of React (`createElement`, `useState`, `useReducer`, `useEffect`,
 * `useMemo`, `useRef`, `Fragment`) to execute the component tree and collect the
 * rendered nodes, which catches:
 *
 *  - references to a variable that does not exist at render time,
 *  - a hook called conditionally (order mismatch),
 *  - a row rendered with the wrong props shape.
 *
 * It is not a substitute for looking at the page; it only proves the code runs.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
// Tests live in <package>/test, so the package under test is one level up.
const PKG = path.dirname(HERE);

// ——— a minimal React ————————————————————————————————————————————
const hookState = [];
let cursor = 0;
let pendingEffects = [];
let rerender = () => {};

const React = {
  Fragment: Symbol("Fragment"),
  createElement(type, props, ...children) {
    if (props !== null && typeof props === "object" && "key" in props) {
      const { key, ...rest } = props;
      props = rest;
    }
    return { type, props: props ?? {}, children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false) };
  },
  useState(initial) {
    const index = cursor++;
    if (!(index in hookState)) hookState[index] = typeof initial === "function" ? initial() : initial;
    const set = (next) => {
      hookState[index] = typeof next === "function" ? next(hookState[index]) : next;
      rerender();
    };
    return [hookState[index], set];
  },
  useReducer(reducer, initial) {
    const index = cursor++;
    if (!(index in hookState)) hookState[index] = initial;
    const dispatch = () => {
      hookState[index] = reducer(hookState[index], {});
      rerender();
    };
    return [hookState[index], dispatch];
  },
  useMemo(factory, _deps) {
    cursor++;
    return factory();
  },
  useRef(initial) {
    const index = cursor++;
    if (!(index in hookState)) hookState[index] = { current: initial };
    return hookState[index];
  },
  useEffect(effect, _deps) {
    cursor++;
    pendingEffects.push(effect);
  },
  useCallback(fn, _deps) {
    cursor++;
    return fn;
  },
};

const h = React.createElement;

// ——— load the client module the way the browser does —————————————————
const source = fs.readFileSync(path.join(PKG, "lib", "client.js"), "utf8");
let captured;
const window = {
  __ModuleLoader__: {
    load(options) {
      captured = options;
    },
  },
};

const requireShim = (name) => {
  if (name === "react") return React;
  if (name === "react/jsx-runtime") return { jsx: h, jsxs: h, Fragment: React.Fragment };
  if (name === "@deepseek-ai/dsh-client-ui-primitives") return {};
  if (name === "@deepseek-ai/dsh-client-ui-slots") return {};
  if (name === "@deepseek-ai/dsh-client-store") return {};
  throw new Error(`unexpected require(${name})`);
};

const moduleObject = { exports: {} };
new Function("window", "require", "module", "exports", source).call(
  moduleObject.exports,
  window,
  requireShim,
  moduleObject,
  moduleObject.exports,
);

assert.equal(captured?.id, "dsh-tool-gate", "the bundle registers under its package name");
const api = captured.factory(requireShim);
assert.equal(typeof api.apply, "function", "the bundle exports apply()");
assert.deepEqual(api.inject, ["slots", "configForms"], "the bundle declares its client services");

// ——— collect the rendered tree ————————————————————————————————————
/** Render a node tree, invoking function components, into a flat text form. */
function render(node, depth = 0) {
  if (node === null || node === undefined || node === false) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map((child) => render(child, depth)).join("");
  if (typeof node.type === "function") {
    const saved = cursor;
    cursor = 0;
    const out = node.type({ ...node.props, children: node.children });
    cursor = saved;
    return render(out, depth + 1);
  }
  if (node.type === React.Fragment) return render(node.children, depth + 1);
  return render(node.children, depth + 1);
}

// ——— the host-side pieces the page talks to ————————————————————————
const families = [
  { id: "blender", label: "Blender", description: "3D", builtin: false, enabled: true, count: 15, tokens: 8415,
    members: ["blender_rt_do", "blender_viewport"], gateway: "blender", packages: ["dsh-blender-plugin"], prefixes: [],
    promptDisclosure: { available: false, reason: "no-prose", chars: 0, names: [], required: false, enabled: false, hasText: false } },
  { id: "free_search", label: "搜索", description: "", builtin: false, enabled: true, count: 9, tokens: 2576,
    members: ["free_search_query"], gateway: "free_search", packages: ["dsh-free-search"], prefixes: [],
    promptDisclosure: { available: true, reason: "ready", chars: 2576, names: ["free-search:engines"], required: false,
      enabled: true, hasText: true } },
  { id: "session", label: "会话检索", description: "检索历史会话", builtin: true, enabled: true, count: 5, tokens: 1242,
    members: ["session_search"], gateway: "session", packages: ["@deepseek-ai/dsh-tool-session-query"], prefixes: [],
    promptDisclosure: { available: false, reason: "required-only", chars: 630, names: ["session:help"], required: true,
      enabled: false, hasText: true } },
  // A family whose plugin registers no tool: its gateway is not mounted, so the
  // row must not appear. "0 个工具 · 网关 agent" reads like a broken plugin.
  { id: "agent", label: "Agent 内核", description: "", builtin: true, enabled: true, count: 0, tokens: 0,
    members: [], gateway: "agent", packages: ["@deepseek-ai/dsh-agent"], prefixes: [], hidden: true,
    promptDisclosure: { available: false, reason: "no-prose", chars: 0, names: [], required: false, enabled: false } },
];
// Packages with no family: read-only, but still shown so their prompt weight is
// visible rather than silently dropped.
const ungrouped = [
  { package: "@deepseek-ai/dsh-tool-goal", thirdParty: false, reason: "resident", toolCount: 3, chars: 1056,
    names: ["tool:goal"], enabled: null },
  { package: "@deepseek-ai/dsh-client-ui-deliverables", thirdParty: false, reason: "no-tools", toolCount: 0,
    chars: 2608, names: ["deliverables:ui"], enabled: null },
];
const payload = {
  schemaVersion: 1, enabled: true, builtinFamilies: true, promptDisclosure: true,
  wireToolCount: 58, savedTokens: 31725, families, ungrouped,
  config: { listDetail: true, staticNotice: true, interceptDirectCalls: true, guardFallback: true,
    concurrencyDelegate: false, freeze: true, unknownOwnerPolicy: "expose", gatewayPrefix: "" },
};

const configValue = {
  enabled: true, builtinFamilies: true, promptDisclosure: true,
  families: { blender: { enabled: true } }, promptPlugins: { "dsh-free-search": { enabled: true } },
  listDetail: true, staticNotice: true, interceptDirectCalls: true, guardFallback: true,
  concurrencyDelegate: false, freeze: true, unknownOwnerPolicy: "expose", gatewayPrefix: "",
};
const snapshot = {
  status: "ready", value: configValue, base: {}, user: configValue, revision: 3, writable: true, mode: "host",
};
const mutations = [];
const form = {
  getSnapshot: () => snapshot,
  subscribe: () => () => {},
  mutate: (ops, revision) => mutations.push({ ops, revision }),
  unset: () => {},
  set: () => {},
  dispose: () => {},
};

// `SettingsPage` fetches the bridge; stub the network with the payload above.
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, value: payload }) });
globalThis.AbortController ??= class { constructor() { this.signal = undefined; } abort() {} };

// ——— the slot contract ————————————————————————————————————————————
let registered;
const ctx = {
  configForms: { get: (id) => { assert.equal(id, "dsh-tool-gate", "the form is fetched by entry id"); return form; } },
  slots: {
    inject: (_name, fn) => fn(),
    register: (meta, component) => {
      registered = { meta, component };
      return () => {};
    },
  },
};
// `useStyles` touches `document`; the page must not depend on more than this.
const styleNodes = [];
globalThis.document = {
  querySelector: () => null,
  createElement: () => {
    const node = { dataset: {}, textContent: "", setAttribute() {}, appendChild() {} };
    return node;
  },
  head: { appendChild: (node) => styleNodes.push(node) },
};

api.apply(ctx);
assert.equal(registered?.meta?.name, "plugins.bundle.config", "the page registers on the bundle slot");
assert.equal(registered.meta.key, "dsh-tool-gate", "keyed by the package name");

// A page render runs with the bridge payload once the fetch resolves; here the
// promise is already stubbed, so the first paint shows the loading state and the
// second shows the rows. Both must be free of exceptions.
const component = registered.component;

// summary view
cursor = 0;
hookState.length = 0;
pendingEffects = [];
const summaryText = render(h(component, { view: "summary" }));
assert.ok(summaryText !== undefined, "the summary view renders");

// page view: first paint (loading)
cursor = 0;
hookState.length = 0;
pendingEffects = [];
const loading = render(h(component, { view: "page", form }));
assert.match(loading, /工具网关|正在读取|家族/, "the page renders its first paint");

// Run the effects the first paint queued (that is what starts the bridge fetch),
// let the stubbed response settle, then re-render with the same hook state — the
// same sequence React performs.
rerender = () => {};
for (const effect of pendingEffects.splice(0)) effect();
await Promise.resolve();
await new Promise((resolve) => setTimeout(resolve, 0));
cursor = 0;
const page = render(h(component, { view: "page", form }));

// One header for one list: the whole point of the merge is that families and
// their prompt switches are not two separate lists the user has to reconcile.
assert.ok(page.includes("家族折叠与提示词披露"), "the merged section header renders");
assert.equal(
  page.split("家族折叠与提示词披露").length - 1,
  1,
  "there is exactly one such header, not one per list",
);

assert.match(page, /Blender/, "a third-party family is listed");
assert.match(page, /会话检索/, "a builtin family is listed");
assert.match(page, /提示词随 list 披露/, "the prompt sub-switch sits on the family row");
// The switch belongs to a family row, so the prose it governs is described on
// that same row rather than in a separate plugin list.
assert.ok(page.includes("约 2576 字符"), "a family with prose says how much");
assert.ok(page.includes("永不摘除"), "a family whose prose is required says so");
assert.ok(page.includes("无注入"), "a family with no prose says so");
assert.match(page, /内置/, "a first-party family is labelled");

// Packages with no family stay visible, read-only: the user must be able to see
// that they inject text without a switch being offered that does nothing.
assert.match(page, /未参与折叠/, "ungrouped packages get their own read-only section");
assert.match(page, /@deepseek-ai\/dsh-tool-goal/, "a resident package is listed");
assert.match(page, /dsh-client-ui-deliverables/, "a prompt-only package is listed");
assert.match(page, /工具全部常驻/, "and says why it has no switch");
assert.match(page, /只读/, "and is marked read-only");

assert.match(page, /wire 上 58 个工具/, "the summary line reports the live wire count");
assert.equal(/Agent 内核/.test(page), false, "a family with no members is not rendered as a row");
assert.ok(styleNodes.length === 1, "the stylesheet is injected exactly once");

console.log("OK client renders: one merged list, read-only ungrouped rows, badges, summary line");
