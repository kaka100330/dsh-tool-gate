/**
 * Naming, classification and self-check — the four layers of 0.9.0, tested offline.
 *
 * The three bugs this release fixes were all *naming* bugs: a family called
 * `subagent2` (a number nobody could interpret), a family keyed by a module
 * specifier (`@vectorize-io/hindsight-coding-agents/dsh`) so the config key it was
 * supposed to answer to did nothing, and eighteen `ops_*` tools attributed to the
 * engine because "whose context this registration arrived on" was mistaken for
 * "who registered it".
 *
 * Each fix is a pure function with a rule, and a rule that is only exercised by the
 * full profile harness is a rule that silently rots. This suite pins them:
 *
 *  - identity  — `canonicalPackage`, `familyIdOf`, `disambiguateId` (never numeric)
 *  - families  — `deriveFamilies`, `applyFamilyOverrides` (aliases, orphan keys)
 *  - resident  — the single residency predicate, derived from owner + prefix
 *  - degenerate— `assessFamily` at `k = 3`, and `force`
 *  - verify    — `verifyAttribution` (engine counter-evidence, downgrade, conflict)
 *  - diagnose  — D1…D9, each triggered once, plus a healthy snapshot that is silent
 */
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const PKG = path.dirname(HERE);
const at = (relative) => pathToFileURL(path.join(PKG, relative)).href;

const disc = await import(at("lib/discovery.js"));
const deg = await import(at("lib/degenerate.js"));
const diag = await import(at("lib/diagnostics.js"));
const { createResident, nameOnlyResident, NAMED_RESIDENT } = await import(at("lib/resident.js"));
const eng = await import(at("lib/engine-packages.js"));
const attr = await import(at("lib/attribution-verify.js"));
const chan = await import(at("lib/ownership-channel.js"));

const DIGITS = /[0-9]/;

// ——— 1. Identity: a package name, never a module specifier ——————————————
{
  const canonical = chan.canonicalPackage("@vectorize-io/hindsight-coding-agents/dsh");
  assert.equal(canonical.pkg, "@vectorize-io/hindsight-coding-agents", "the subpath is dropped");
  // The subpath is kept for display only, in Node's own `./sub` form — it never
  // reaches a family id, a config key or the wire.
  assert.equal(canonical.subpath, "./dsh", "and remembered separately, for display");
  assert.equal(chan.canonicalPackage("./lib/index.js"), undefined, "a relative path is not a package");
  assert.equal(chan.canonicalPackage("/abs/path/index.js"), undefined, "nor is an absolute path");
  assert.equal(chan.canonicalPackage("node:fs"), undefined, "nor a protocol URL");

  // A sub-path and its package must not name two different families — that was the
  // hindsight bug: one package, two identities, one dead config key.
  assert.equal(disc.familyIdOf("@vectorize-io/hindsight-coding-agents"), "hindsight_coding_agents");
  assert.equal(disc.familyIdOf("dsh"), "dsh", "which is why the specifier looked plausible");
  assert.equal(disc.familyIdOf("dsh-tool-session-query"), "session_query");
  assert.equal(disc.familyIdOf("@perrylink/dsh-github"), "github");
  assert.equal(disc.familyIdOf("dsh-ops"), "ops");
}

// ——— 2. Naming: three semantic attempts, no digits, ever ——————————————————
{
  const taken = new Set(["subagent"]);
  assert.equal(disc.disambiguateId("subagent", "dsh-tool-subagent", taken), "subagent_tools",
    "the second attempt is the domain suffix, not a counter");
  assert.equal(disc.disambiguateId("subagent", "@deepseek-ai/dsh-tool-subagent", taken), "deepseek_ai_subagent",
    "the third attempt is the scope");
  const sizeBefore = taken.size;
  assert.equal(disc.disambiguateId("subagent", "dsh-tool-subagent", taken), undefined,
    "exhausted: the package does not become a family rather than getting a number");
  assert.equal(taken.size, sizeBefore, "and a failed attempt claims nothing");

  const taken2 = new Set();
  const first = disc.disambiguateId("free_search", "dsh-free-search", taken2);
  assert.equal(DIGITS.test(first), false, "no digits in a family id");
  assert.equal(disc.ID_SUFFIX, "_tools", "the disambiguating suffix is a domain word");
}

// ——— 3. Family derivation: resident tools define nothing ————————————————————
{
  const owners = {
    subagent_run: "dsh-tool-subagent",
    hindsight_reflect: "@vectorize-io/hindsight-coding-agents",
    write: "dsh-tool-something-else",
  };
  const specifiers = new Map([
    ["@vectorize-io/hindsight-coding-agents", ["@vectorize-io/hindsight-coding-agents/dsh"]],
  ]);
  const families = disc.deriveFamilies({ owners, reservedIds: ["subagent"], specifiers });

  assert.deepEqual(Object.keys(families).sort(), ["hindsight_coding_agents", "subagent_tools"]);
  const subagent = families.subagent_tools;
  assert.equal(subagent.wire, "subagent_tools", "the wire name is the family id");
  assert.deepEqual(subagent.packages, ["dsh-tool-subagent"], "keyed by package, never by specifier");
  assert.equal(DIGITS.test(subagent.wire), false);
  for (const family of Object.values(families)) {
    assert.equal(DIGITS.test(family.id), false, `family id ${family.id} has no digits`);
    assert.equal(DIGITS.test(family.wire), false, `wire ${family.wire} has no digits`);
    for (const pkg of family.packages) {
      assert.equal(pkg.includes("/", pkg.startsWith("@") ? pkg.indexOf("/") + 1 : 0), false,
        `package ${pkg} is bare, not a sub-path specifier`);
    }
  }

  // The old numeric ids are recognized as aliases and never produced again.
  assert.ok(families.subagent_tools.aliases.includes("subagent2"), "the legacy numeric key still resolves");
  const hindsight = families.hindsight_coding_agents;
  assert.ok(hindsight.aliases.includes("dsh"),
    "the Loader specifier it used to be keyed by is an alias, so `families.dsh` keeps working");

  // The plugin's *own* gateways must never count as taken ids: they are derived
  // from the family table, so counting them makes the table depend on itself (round
  // one registers `github`, round two renames the family to `github_tools` and the
  // session ends up with two gateways for one family). `index.js` excludes them
  // before calling here; this pins the shape that makes that work.
  const stable = disc.deriveFamilies({
    owners: { github_tools: "dsh-tool-gate", gh_issue: "dsh-github" },
    reservedIds: ["gh_issue"],   // what the caller passes: everything the gate does not own
    selfPackage: "dsh-tool-gate",
  });
  assert.deepEqual(Object.keys(stable), ["github"], "the family keeps its plain id round after round");
  assert.equal(stable.github.wire, "github");

  // A resident tool is its package's only tool ⇒ no family, no gateway, no switch.
  assert.equal(Object.values(families).some((family) => family.packages.includes("dsh-tool-something-else")), false,
    "a package whose tools are all resident defines no family");

  // Exhausting the name space is reported, not silently numbered.
  const rejected = [];
  const none = disc.deriveFamilies({
    owners: { subagent_run: "dsh-tool-subagent" },
    reservedIds: ["subagent", "subagent_tools", "deepseek_ai_subagent"],
    onReject: (reason) => rejected.push(reason),
  });
  assert.deepEqual(none, {}, "no family is created");
  assert.deepEqual(rejected, [{ pkg: "dsh-tool-subagent", base: "subagent", reason: "id-collision" }]);
}

// ——— 4. Overrides: aliases resolve, orphan keys are reported ————————————————
{
  const owners = {
    hindsight_reflect: "@vectorize-io/hindsight-coding-agents",
    a1: "dsh-alpha",
    b1: "dsh-beta",
  };
  const specifiers = new Map([
    ["@vectorize-io/hindsight-coding-agents", ["@vectorize-io/hindsight-coding-agents/dsh"]],
  ]);
  const derived = disc.deriveFamilies({ owners, reservedIds: [], specifiers });
  assert.deepEqual(Object.keys(derived).sort(), ["alpha", "beta", "hindsight_coding_agents"]);

  const report = { aliasUses: [], orphanKeys: [], rejected: [] };
  const patched = disc.applyFamilyOverrides(derived, {
    dsh: { enabled: false },        // legacy specifier key → hindsight_coding_agents
    alpha: { force: true },
    beta: { packages: ["@acme/one", "@acme/two"] },
    typo: {},                       // matches nothing and names nothing: an orphan
  }, { report });

  assert.equal(patched.hindsight_coding_agents.enabled, false,
    "the config key the user actually had keeps working");
  assert.deepEqual(report.aliasUses, [{ key: "dsh", family: "hindsight_coding_agents" }]);
  assert.deepEqual(report.orphanKeys, ["typo"], "a key that can never do anything is reported, not dropped");
  assert.equal(patched.alpha.force, true);
  assert.deepEqual(patched.beta.packages, ["@acme/one", "@acme/two"]);
  assert.equal(patched.beta.packages.includes("dsh-beta"), false, "the derived package was claimed by the override");
}

// ——— 5. Residency: one predicate, derived from owner + prefix ——————————————
{
  const owners = {
    ops_shell: "dsh-ops",
    ops_impostor: "dsh-other",
    write: "dsh-whatever",
    context_read: "billion-context",
    engine_thing: "@deepseek-ai/dsh-agent-loop",
    free_engines: "dsh-free-search",
  };
  const isResident = createResident({ ownerOf: (name) => owners[name], pins: ["free_engines"] });

  assert.equal(isResident("ops_shell"), true, "ops_* owned by dsh-ops is resident, by rule not by list");
  assert.equal(isResident("ops_impostor"), false, "the prefix alone is not enough — the owner must be dsh-ops");
  assert.equal(isResident("write"), true, "core names are resident");
  assert.equal(isResident("context_read"), true, "context packages are resident");
  assert.equal(isResident("engine_thing"), true, "engine-owned tools never become a family");
  assert.equal(isResident("free_engines"), true, "a user pin is resident");
  assert.equal(isResident("alpha_one"), false, "an ordinary third-party tool is collapsible");
  assert.equal(isResident(""), false);

  // The name-level fallback knows only names, and says so by knowing nothing else.
  const fallback = nameOnlyResident(["pinned"]);
  assert.equal(fallback("pinned"), true);
  assert.equal(fallback("write"), true);
  assert.equal(fallback("ops_shell"), false, "the fallback cannot see owners, so it cannot claim ops_*");

  assert.equal(eng.isEnginePackage("@deepseek-ai/dsh-agent-loop"), true);
  assert.equal(eng.isEnginePackage("dsh-ops"), false, "the ops plugin is a plugin, not machinery");
  assert.equal(eng.isContextPackage("billion-context"), true);
  assert.equal(eng.isOpsTool("ops_shell", "dsh-ops"), true);
  assert.equal(eng.isOpsTool("ops_shell", "someone-else"), false);
  assert.equal(NAMED_RESIDENT.has("write"), true);
}

// ——— 6. Degenerate families: k = 3, strictly greater ——————————————————————
{
  const schema = (name, tokens) => ({ name, tokens });
  const tokensOf = (value) => value.tokens;
  const cost = deg.gatewayCost("desc");
  assert.equal(deg.FIXED_OVERHEAD, 60);
  assert.equal(deg.DEFAULT_THRESHOLD, 3, "the gate must be worth three of its own gateways");
  assert.equal(cost, 60 + deg.estimateTokens("desc"));

  const worth = deg.assessFamily({
    family: { id: "worth", description: "desc" },
    members: [schema("m1", 1000), schema("m2", 1000)],
    isResident: () => false,
    threshold: 3,
    tokensOf,
  });
  assert.equal(worth.worth, true);
  assert.equal(worth.reason, deg.REASONS.WORTH);
  assert.equal(worth.collectableCount, 2);
  assert.equal(worth.saving, 2000 - cost);

  // Exactly k× the cost is not enough: the comparison is strict, so a gateway that
  // saves precisely its own price three times over still is not built.
  const boundary = deg.assessFamily({
    family: { id: "boundary", description: "desc" },
    members: [schema("m1", 3 * cost)],
    isResident: () => false,
    threshold: 3,
    tokensOf,
  });
  assert.equal(boundary.collectableTokens, 3 * cost);
  assert.equal(boundary.worth, false, "3× is the threshold, not the pass mark");
  assert.equal(boundary.reason, deg.REASONS.BELOW);

  const justOver = deg.assessFamily({
    family: { id: "just", description: "desc" },
    members: [schema("m1", 3 * cost + 1)],
    isResident: () => false,
    threshold: 3,
    tokensOf,
  });
  assert.equal(justOver.worth, true, "one token over and the gateway is built");

  const allResident = deg.assessFamily({
    family: { id: "resident", description: "desc" },
    members: [schema("write", 100), schema("edit", 100)],
    isResident: createResident({}),
    tokensOf,
  });
  assert.equal(allResident.reason, deg.REASONS.ALL_RESIDENT);
  assert.equal(allResident.collectableCount, 0);
  assert.equal(allResident.worth, false, "a gateway with nothing behind it hides nothing");

  const empty = deg.assessFamily({
    family: { id: "empty", description: "" },
    members: [],
    isResident: () => false,
    tokensOf,
  });
  assert.equal(empty.reason, deg.REASONS.EMPTY);

  // Half resident, half collapsible: legitimate, but it must be visible.
  const half = deg.assessFamily({
    family: { id: "half", description: "desc" },
    members: [schema("write", 10), schema("m2", 2000)],
    isResident: createResident({}),
    tokensOf,
  });
  assert.equal(half.halfCollapsed, true);
  assert.equal(half.residentCount, 1);
  assert.equal(half.collectableCount, 1);

  // `force: true` is the user's override — the one way past the threshold.
  const forced = deg.assessFamily({
    family: { id: "forced", description: "desc", force: true },
    members: [schema("m1", 1)],
    isResident: () => false,
    tokensOf,
  });
  assert.equal(forced.worth, true);
  assert.equal(forced.reason, deg.REASONS.FORCED);

  const families = {
    on: { id: "on", enabled: true },
    off: { id: "off", enabled: false },
  };
  const assessments = new Map([
    ["on", { worth: true }],
    ["off", { worth: true }],
  ]);
  assert.deepEqual([...deg.collapsibleIds(families, assessments)], ["on"],
    "a family the user disabled is not collapsed, however profitable");
  assert.equal(deg.collapsibleIds(families, undefined), undefined,
    "no assessments must mean suppress nothing, never suppress everything");
}

// ——— 7. Attribution: declare, then verify ————————————————————————————————
{
  assert.equal(attr.makeIdentity({ pkg: "p", source: "declared" }).confidence, "high");
  assert.equal(attr.makeIdentity({ pkg: "p", source: "context-chain" }).confidence, "medium");
  assert.equal(attr.makeIdentity({ pkg: "p", source: "stack" }).confidence, "medium");
  assert.equal(attr.makeIdentity({ pkg: "p", source: "static-table" }).confidence, "low");
  assert.equal(attr.makeIdentity({ pkg: "p" }).confidence, "unknown", "no source means no confidence");

  const ENGINE = "@deepseek-ai/dsh-agent-loop";
  const at = (name, pkg, extra) => ({ name, identity: attr.makeIdentity({ pkg, ...extra }) });

  // R-b — the ops_* case: the registry said the host, the package's source says
  // otherwise, and the source wins.
  const byName = attr.verifyAttribution({
    entries: [at("ops_shell", ENGINE, { source: "context-chain" })],
    evidence: { declared: new Map([["ops_shell", "dsh-ops"]]) },
  });
  assert.equal(byName.repairs.get("ops_shell").pkg, "dsh-ops", "the declaring package wins");
  assert.equal(byName.repairs.get("ops_shell").confidence, "high");
  assert.equal(byName.downgrades.size, 0);
  assert.match(byName.repairs.get("ops_shell").evidence, /dsh-ops/);

  // R-a — a prefix claim, for names built as PREFIX + capability (no literal).
  const byPrefix = attr.verifyAttribution({
    entries: [at("ops_query", ENGINE, { source: "context-chain" })],
    evidence: { prefixes: new Map([["dsh-ops", ["ops_"]]]) },
  });
  assert.equal(byPrefix.repairs.get("ops_query").pkg, "dsh-ops");
  assert.match(byPrefix.repairs.get("ops_query").evidence, /ops_/);

  // Somebody else's prefix does not reach in; the most specific claim wins.
  const specific = attr.verifyAttribution({
    entries: [at("blender_rt_do", ENGINE, { source: "context-chain" })],
    evidence: { prefixes: new Map([["dsh-blender-plugin", ["gui_"]], ["dsh-rt", ["blender_rt_"]]]) },
  });
  assert.equal(specific.repairs.get("blender_rt_do").pkg, "dsh-rt", "longest prefix wins");

  // No evidence at all: machinery owns nothing, so the tool is exposed, not hidden.
  const down = attr.verifyAttribution({ entries: [at("mystery", ENGINE, { source: "context-chain" })] });
  assert.equal(down.repairs.size, 0, "nothing is invented");
  assert.deepEqual([...down.downgrades], ["mystery"]);
  assert.equal(down.diagnostics[0].severity, "warn");
  assert.equal(down.diagnostics[0].code, "D6");
  assert.equal(down.diagnostics[0].source, "attribution");

  // A prefix claimed by machinery is not evidence.
  const enginePrefix = attr.verifyAttribution({
    entries: [at("ops_shell", ENGINE, { source: "context-chain" })],
    evidence: { prefixes: new Map([[ENGINE, ["ops_"]], ["dsh-ops", ["ops_"]]]) },
  });
  assert.equal(enginePrefix.repairs.get("ops_shell").pkg, "dsh-ops", "an engine package cannot claim a prefix");

  // R-c — contradiction, reported rather than repaired.
  const conflict = attr.verifyAttribution({
    entries: [at("weird", "pkg-a", { source: "stack" })],
    evidence: { declared: new Map([["weird", "pkg-b"]]) },
  });
  assert.equal(conflict.conflicts.length, 1);
  assert.deepEqual(conflict.conflicts[0], { name: "weird", owner: "pkg-a", claimedBy: "pkg-b" });
  assert.equal(conflict.diagnostics[0].code, "D2");

  // R-b2 — a name nobody could place, but which a package's own source declares.
  // This is the cold-start shape: the tool registered before this plugin mounted,
  // so the registry answers "unknown" and only the profile can say who owns it.
  const unknownEntry = {
    name: "gh_pr_list",
    identity: attr.makeIdentity({ pkg: "<unknown>", source: "unknown" }),
  };
  const byDeclaration = attr.verifyAttribution({
    entries: [unknownEntry],
    evidence: { declared: new Map([["gh_pr_list", "@perrylink/dsh-github"]]) },
  });
  assert.equal(byDeclaration.repairs.get("gh_pr_list").pkg, "@perrylink/dsh-github");
  assert.equal(byDeclaration.repairs.get("gh_pr_list").confidence, "high");
  assert.equal(byDeclaration.diagnostics.length, 0, "a repair is not a warning");

  // …and a stale table entry is the same kind of guess: the declaration replaces it.
  const staleEntry = at("gh_pr_list", "dsh-old-github", { source: "static-table" });
  const restated = attr.verifyAttribution({
    entries: [staleEntry],
    evidence: { declared: new Map([["gh_pr_list", "@perrylink/dsh-github"]]) },
  });
  assert.equal(restated.repairs.get("gh_pr_list").pkg, "@perrylink/dsh-github");
  assert.equal(staleEntry.identity.confidence, "low", "and the low-confidence entry is why");

  // R-d — a stale table entry whose package is still installed. Not proof of
  // declaration (a package may publish only build output), but no longer a blind
  // guess: `low` becomes `medium` and the family stops crying wolf.
  const stillHere = attr.verifyAttribution({
    entries: [at("hindsight_reflect", "@vectorize-io/hindsight-coding-agents", { source: "static-table" })],
    evidence: { packages: ["@vectorize-io/hindsight-coding-agents"], declared: new Map(), prefixes: new Map() },
  });
  assert.equal(stillHere.repairs.get("hindsight_reflect").confidence, "medium");
  assert.equal(stillHere.repairs.get("hindsight_reflect").source, "table+installed");
  assert.equal(stillHere.diagnostics.length, 0, "a corroborated guess is not a warning");

  // …but a table entry whose package is *gone* stays a guess, so D6 keeps firing.
  const vanished = attr.verifyAttribution({
    entries: [at("hindsight_reflect", "dsh-uninstalled-thing", { source: "static-table" })],
    evidence: { packages: ["dsh-something-else"] },
  });
  assert.equal(vanished.repairs.size, 0, "an absent package corroborates nothing");

  // A healthy entry produces nothing at all.
  const clean = attr.verifyAttribution({
    entries: [at("alpha_one", "dsh-alpha", { source: "declared" })],
    evidence: { declared: new Map([["alpha_one", "dsh-alpha"]]) },
  });
  assert.equal(clean.repairs.size + clean.downgrades.size + clean.conflicts.length + clean.diagnostics.length, 0);
}

// ——— 8. Self-check: D1…D9 ——————————————————————————————————————————————
{
  /** A snapshot in which every assertion passes. */
  const healthy = () => {
    const owners = { a1: "dsh-alpha", a2: "dsh-alpha" };
    const families = {
      alpha: { id: "alpha", label: "Alpha", packages: ["dsh-alpha"], prefixes: [], tools: [], enabled: true },
    };
    return {
      families,
      owners,
      identities: new Map([
        ["a1", { pkg: "dsh-alpha", source: "declared", confidence: "high" }],
        ["a2", { pkg: "dsh-alpha", source: "declared", confidence: "high" }],
      ]),
      membersByFamily: new Map([["alpha", ["a1", "a2"]]]),
      ungrouped: [],
      gateways: new Map([["alpha", "alpha_tools"]]),
      toolNames: ["a1", "a2", "alpha_tools"],
      isResident: () => false,
      selfPackage: "dsh-tool-gate",
      assessments: new Map([["alpha", { worth: true, count: 2, residentCount: 0, collectableCount: 2,
        collectableTokens: 4000, cost: 80, saving: 3920, threshold: 3, ratio: 49, reason: "collectable",
        forced: false, halfCollapsed: false }]]),
      report: { aliasUses: [], orphanKeys: [], rejected: [] },
    };
  };
  const check = (mutate) => {
    const input = healthy();
    mutate?.(input);
    return diag.diagnose(input);
  };
  const has = (rows, id, code) => rows.some((row) => row.id === id && (code === undefined || row.code === code));

  assert.deepEqual(check(), [], "a consistent snapshot is silent");
  assert.equal(diag.worst([]), undefined);

  // D1 — a tool nobody claims and nobody keeps resident.
  const d1 = check((input) => { input.owners.c1 = "dsh-ghost"; });
  assert.equal(has(d1, "D1", "uncovered-tools"), true);
  assert.equal(d1.find((row) => row.id === "D1").severity, "error");

  // …but this plugin's own gateways are its output, not members of a family: they
  // are attributed to the gate and can never appear in a `family.packages` list.
  assert.equal(check((input) => { input.owners.github_tools = "dsh-tool-gate"; }).length, 0,
    "a gateway owned by the plugin itself is not an uncovered tool");

  // D2 — a family keyed by a specifier (the hindsight shape)…
  const d2a = check((input) => {
    input.families.beta = { id: "beta", label: "Beta", packages: ["@acme/pkg/lib"], prefixes: [], tools: [], enabled: true };
    input.membersByFamily.set("beta", ["b1"]);
  });
  assert.equal(has(d2a, "D2", "specifier-as-package"), true);

  // …and a package whose tools actually landed in a *different* family.
  const d2b = check((input) => {
    input.families.beta = { id: "beta", label: "Beta", packages: ["dsh-beta"], prefixes: [], tools: [], enabled: true };
    input.owners.b1 = "dsh-beta";
    input.membersByFamily.set("beta", []);
    input.membersByFamily.set("alpha", ["a1", "a2", "b1"]);  // the split
  });
  assert.equal(has(d2b, "D2", "claimed-without-members"), true);

  // A package that registers nothing here (or whose tools are all resident) has no
  // members to claim and is not a defect — `fs_search` and `pwsh_persistent` are
  // exactly this shape in a real profile, and flagging them made the check cry wolf.
  assert.equal(check((input) => {
    input.families.beta = { id: "beta", label: "Beta", packages: ["dsh-beta"], prefixes: [], tools: [], enabled: true };
    input.membersByFamily.set("beta", []);
  }).length, 0, "an empty package is not a split claim");

  // D3 — the false `resident` reason this release started from.
  const d3 = check((input) => {
    input.ungrouped.push({ package: "dsh-gamma", reason: "resident", tools: ["g1", "g2"] });
  });
  assert.equal(has(d3, "D3", "false-resident-reason"), true);
  assert.equal(check((input) => {
    input.ungrouped.push({ package: "dsh-gamma", reason: "no-collapsible-members", tools: ["g1"] });
    input.isResident = (name) => name === "g1";
  }).length, 0, "the truthful reason is not flagged");

  // D4 — a gateway named like a tool, carrying a digit, or shared with another.
  assert.equal(has(check((input) => { input.gateways.set("alpha", "a1"); }), "D4", "wire-collides-with-tool"), true);
  assert.equal(has(check((input) => { input.gateways.set("alpha", "alpha2"); }), "D4", "wire-has-digit"), true);
  assert.equal(has(check((input) => {
    input.families.beta = { id: "beta", label: "Beta", packages: ["dsh-beta"], prefixes: [], tools: [], enabled: true };
    input.membersByFamily.set("beta", ["b1"]);
    input.owners.b1 = "dsh-beta";
    input.gateways.set("beta", "alpha_tools");
  }), "D4", "wire-duplicate"), true);

  // D5 — an enabled family that cannot pay for its gateway.
  const d5 = check((input) => {
    input.assessments.set("alpha", { ...input.assessments.get("alpha"), worth: false, reason: "below-threshold", saving: 10 });
  });
  assert.equal(has(d5, "D5", "degenerate-family:below-threshold"), true);
  assert.equal(d5.find((row) => row.id === "D5").severity, "warn", "fixable by force/threshold ⇒ warn");

  // "Nothing collectable" is a fact, not a defect: every member is resident, and no
  // setting changes that. It stays visible, in blue.
  const d5b = check((input) => {
    input.assessments.set("alpha", { ...input.assessments.get("alpha"), worth: false,
      reason: "no-collectable-members", collectableCount: 0, saving: -80, halfCollapsed: false });
  });
  assert.equal(has(d5b, "D5", "degenerate-family:no-collectable-members"), true);
  assert.equal(d5b.find((row) => row.id === "D5").severity, "info");

  // D6 — a family resting on weak attribution.
  const d6 = check((input) => {
    input.identities.set("a2", { pkg: "dsh-alpha", source: "static-table", confidence: "low" });
  });
  assert.equal(has(d6, "D6", "low-confidence-attribution"), true);

  // D7 — half resident, half collapsible: legitimate but visible.
  const d7 = check((input) => {
    input.assessments.set("alpha", { ...input.assessments.get("alpha"), halfCollapsed: true, residentCount: 1 });
  });
  assert.equal(has(d7, "D7", "half-collapsed-family"), true);
  assert.equal(d7.find((row) => row.id === "D7").severity, "info");

  // D8 — a config key that resolves to nothing, and one that resolved by alias.
  const d8 = check((input) => {
    input.report.orphanKeys.push("typo");
    input.report.aliasUses.push({ key: "dsh", family: "hindsight_coding_agents" });
  });
  assert.equal(has(d8, "D8", "unknown-family-key"), true);
  assert.equal(has(d8, "D8", "config-alias"), true);

  // D9 — ids that could not be named without a number.
  const d9 = check((input) => {
    input.report.rejected.push({ pkg: "dsh-tool-subagent", base: "subagent", reason: "id-collision" });
  });
  assert.equal(has(d9, "D9", "id-collision"), true);

  // Errors sort first, so the first row of a mixed snapshot is the one that matters.
  const mixed = check((input) => {
    input.report.orphanKeys.push("typo");
    input.owners.c1 = "dsh-ghost";
  });
  assert.equal(mixed[0].severity, "error");
  assert.equal(diag.worst(mixed), "error");
  assert.deepEqual(diag.SEVERITIES, ["error", "warn", "info"]);
  for (const row of mixed) {
    assert.equal(typeof row.text, "string");
    assert.equal(typeof row.id, "string");
    assert.equal(diag.SEVERITIES.includes(row.severity), true);
  }
}

console.log("ALL NAMING CHECKS PASSED");
