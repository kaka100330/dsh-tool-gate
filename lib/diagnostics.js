/**
 * Consistency self-check — `describe().diagnostics`.
 *
 * Every bug this release fixes had the same shape: an internal decision and the
 * thing shown to the user disagreed, and nothing noticed. `ungrouped` said the
 * hindsight package was "resident" while its eight tools were behind a gateway;
 * `dsh-ops` said "no-tools" while eighteen `ops_*` tools were attributed to an
 * engine package; a family card said "18 tools, 7133 tokens saved" while seven of
 * them were resident and could never be hidden.
 *
 * Each of those is a checkable assertion. This module states them as D1–D8 and
 * runs them on every snapshot, so the next version of the same mistake shows up as
 * a red row on the settings page instead of as a mystery in the tool list.
 *
 * Pure functions, no host, no IO: the caller passes the snapshot it already has.
 */

/** Severity ordering, worst first — for `worst()` and page badges. */
export const SEVERITIES = Object.freeze(["error", "warn", "info"]);

/** The owner value that means "we could not tell" (`owner.js:UNKNOWN`). */
const UNKNOWN_OWNER = "unknown";

/** One diagnostic row. */
function row(id, severity, code, text, extra) {
  return { id, severity, code, text, ...extra };
}

/** The worst severity in a list, or `undefined` when empty. */
export function worst(rows) {
  for (const severity of SEVERITIES) {
    if ((rows ?? []).some((entry) => entry?.severity === severity)) return severity;
  }
  return undefined;
}

/** `@scope/pkg/sub` → `@scope/pkg`; a bare name is returned unchanged. */
function packageOfSpecifier(value) {
  if (typeof value !== "string" || value === "") return undefined;
  const at = value.startsWith("@") ? value.indexOf("/", 1) : value.indexOf("/");
  if (at < 0) return value.startsWith("@") ? undefined : value;
  if (value.startsWith("@")) {
    const next = value.indexOf("/", at + 1);
    return next < 0 ? value : value.slice(0, next);
  }
  return value.slice(0, at);
}

/**
 * Run the assertions.
 *
 * @param input.families - resolved family table.
 * @param input.owners - `{ [toolName]: package | "mcp:<server>" | UNKNOWN }`.
 * @param input.identities - optional `Map<name, { pkg, source, confidence }>`.
 * @param input.membersByFamily - optional `Map<familyId, schema[] | string[]>`.
 * @param input.ungrouped - `describe().ungrouped` rows (need `package`, `reason`,
 *   `tools`).
 * @param input.gateways - optional `Map<familyId, wireName>`.
 * @param input.toolNames - every registered tool name, for the wire-collision check.
 * @param input.isResident - `(name) => boolean`, the single residency predicate.
 * @param input.assessments - optional `Map<familyId, assessment>` (`degenerate.js`).
 * @param input.report - optional `{ aliasUses, orphanKeys, rejected }` from family
 *   resolution.
 * @param input.mcpPrefix - tool-name prefix that marks an MCP-served tool.
 * @returns `[{ id, severity, code, text, ... }]`, worst severity first.
 */
export function diagnose(input) {
  const {
    families = {},
    owners = {},
    identities,
    membersByFamily,
    ungrouped = [],
    gateways,
    toolNames = [],
    isResident,
    assessments,
    report,
    mcpPrefix = "mcp__",
  } = input ?? {};
  const resident = typeof isResident === "function" ? isResident : () => false;
  // `owner.js:identities()` answers `[{ name, identity }]`; a test may hand over a
  // plain `Map`. Normalising here keeps the assertions readable.
  const identityIndex = (() => {
    if (identities instanceof Map) return identities;
    const map = new Map();
    for (const entry of Array.isArray(identities) ? identities : []) {
      if (typeof entry?.name === "string" && entry.identity !== undefined) map.set(entry.name, entry.identity);
    }
    return map;
  })();
  const out = [];
  const table = Object.values(families);
  /** package -> family ids that claim it. */
  const claimed = new Map();
  for (const family of table) {
    for (const pkg of family.packages ?? []) {
      let list = claimed.get(pkg);
      if (list === undefined) claimed.set(pkg, (list = []));
      list.push(family.id);
    }
  }
  /** family id -> member names, from whichever shape the caller passed. */
  const memberNamesOf = (familyId) => {
    const list = membersByFamily?.get?.(familyId);
    if (list === undefined) return [];
    const names = [];
    for (const entry of list) {
      const name = typeof entry === "string" ? entry : entry?.name;
      if (typeof name === "string") names.push(name);
    }
    return names;
  };

  // ——— D1: every owned tool is either resident or covered by a family ———————
  /** package -> tools that a family should be claiming but does not. */
  const orphanedTools = new Map();
  for (const [name, pkg] of Object.entries(owners)) {
    if (typeof pkg !== "string" || pkg === "" || pkg === UNKNOWN_OWNER || pkg === "unknown") continue;
    if (typeof name !== "string" || name === "") continue;
    // MCP tools belong to a server identity, not a package.
    if (pkg.startsWith("mcp:")) continue;
    if (resident(name)) continue;
    if (claimed.has(pkg)) continue;
    let list = orphanedTools.get(pkg);
    if (list === undefined) orphanedTools.set(pkg, (list = []));
    if (list.length < 4) list.push(name);
  }
  for (const [pkg, tools] of orphanedTools) {
    out.push(row(
      "D1",
      "error",
      "uncovered-tools",
      `${pkg} 的 ${tools.length >= 4 ? "≥4" : tools.length} 个工具既非常驻、也不在任一 family.packages 中（如 ${tools.join("、")}）`,
      { package: pkg, tools },
    ));
  }

  // ——— D2: a claimed package must claim at least one member ———————————————
  for (const family of table) {
    const members = memberNamesOf(family.id);
    const explicit = (family.tools ?? []).length > 0;
    for (const pkg of family.packages ?? []) {
      if (pkg.startsWith("mcp:")) continue;
      // A sub-path specifier is the problem this release fixes: families must be
      // keyed by package name, so the page and the config agree.
      const bare = packageOfSpecifier(pkg);
      if (bare !== undefined && bare !== pkg) {
        out.push(row(
          "D2",
          "error",
          "specifier-as-package",
          `家族 ${family.label || family.id} 的 packages 中出现模块说明符「${pkg}」，应为裸包名「${bare}」`,
          { family: family.id, package: pkg },
        ));
      }
      if (explicit) continue;
      if (members.length === 0) {
        // An empty family is legitimate (a family whose plugin registers nothing);
        // D5 reports that. D2 is about a package that *does* own tools but is
        // claimed by a family that does not hold them.
        const owned = Object.entries(owners).filter(([, owner]) => owner === pkg).map(([name]) => name);
        if (owned.length === 0) continue;
        out.push(row(
          "D2",
          "error",
          "claimed-without-members",
          `家族 ${family.label || family.id} 声明了 ${pkg}，但该包的工具没有一个落在这个家族里`,
          { family: family.id, package: pkg, tools: owned.slice(0, 4) },
        ));
      }
    }
  }

  // ——— D3: an "ungrouped because resident" row must really be resident ————
  for (const entry of ungrouped) {
    if (entry?.reason !== "resident") continue;
    const tools = Array.isArray(entry.tools) ? entry.tools : [];
    if (tools.length === 0) continue;
    const loose = tools.filter((name) => !resident(name));
    if (loose.length === 0) continue;
    out.push(row(
      "D3",
      "error",
      "false-resident-reason",
      `${entry.package} 标注为「工具全部常驻」，但 ${loose.length} 个工具并非常驻（如 ${loose.slice(0, 4).join("、")}）`,
      { package: entry.package, tools: loose.slice(0, 8) },
    ));
  }

  // ——— D4: a gateway name must not collide with a tool name ————————————————
  const gatewayRows = gateways instanceof Map
    ? [...gateways.entries()]
    : table.map((family) => [family.id, family.wire ?? family.id]);
  /**
   * Tool names that are not gateways.
   *
   * A gateway is itself a registered tool, so the raw registry always "contains" its
   * own wire name — comparing against it directly flags every healthy family. The
   * collision worth an error is a gateway named like an ordinary tool: that is what
   * would shadow the real thing (`subagent`, in the case this check comes from).
   */
  const gatewayWires = new Set(gatewayRows.map(([, wire]) => wire).filter((wire) => typeof wire === "string"));
  const plainTools = new Set([...toolNames].filter((name) => !gatewayWires.has(name)));
  /**
   * Everything a family holds. A gateway named after one of its own members (or
   * another family's) shadows that tool: the name is in the registry either way, so
   * the plain-tool comparison above cannot see it — `subagent` was exactly this.
   */
  const memberNames = new Set();
  for (const family of table) for (const name of memberNamesOf(family.id)) memberNames.add(name);
  const seenWire = new Map();
  for (const [id, wire] of gatewayRows) {
    if (typeof wire !== "string" || wire === "") continue;
    if (memberNames.has(wire) || plainTools.has(wire)) {
      out.push(row(
        "D4",
        "error",
        "wire-collides-with-tool",
        `家族 ${families[id]?.label || id} 的网关名「${wire}」与一个已注册工具同名`,
        { family: id, wire },
      ));
    }
    if (/[0-9]/.test(wire)) {
      out.push(row(
        "D4",
        "error",
        "wire-has-digit",
        `网关名「${wire}」含数字后缀，语义不明（应为「${wire.replace(/[0-9]+$/g, "")}_tools」这类限定名）`,
        { family: id, wire },
      ));
    }
    if (seenWire.has(wire)) {
      out.push(row(
        "D4",
        "error",
        "wire-duplicate",
        `两个家族共用网关名「${wire}」（${seenWire.get(wire)}、${id}）`,
        { family: id, wire },
      ));
    }
    seenWire.set(wire, id);
  }

  // ——— D5: an enabled family that cannot pay for its gateway ————————————————
  if (assessments instanceof Map) {
    for (const [id, assessment] of assessments) {
      const family = families[id];
      if (family === undefined || family.enabled === false) continue;
      if (assessment.worth === true) continue;
      const detail = assessment.count === 0
        ? "家族没有任何成员"
        : `可折叠 ${assessment.collectableCount}/${assessment.count} 个成员，节省 ${assessment.saving} tok，网关成本 ${assessment.cost} tok（阈值 ${assessment.threshold}×）`;
      out.push(row(
        "D5",
        "warn",
        `degenerate-family:${assessment.reason}`,
        `家族 ${family.label || id} 不成立（${detail}）`,
        { family: id, assessment },
      ));
    }
  }

  // ——— D6: a family resting on weak attribution evidence ——————————————————
  {
    for (const family of table) {
      const weak = [];
      for (const name of memberNamesOf(family.id)) {
        const identity = identityIndex.get(name);
        if (identity === undefined) continue;
        if (identity.confidence === "low") weak.push(name);
      }
      if (weak.length === 0) continue;
      out.push(row(
        "D6",
        "warn",
        "low-confidence-attribution",
        `家族 ${family.label || family.id} 中有 ${weak.length} 个成员归属置信度低（如 ${weak.slice(0, 4).join("、")}）`,
        { family: family.id, tools: weak.slice(0, 8) },
      ));
    }
  }

  // ——— D7: a family that is half resident, half collectable ————————————————
  if (assessments instanceof Map) {
    for (const [id, assessment] of assessments) {
      if (assessment.halfCollapsed !== true) continue;
      const family = families[id];
      out.push(row(
        "D7",
        "info",
        "half-collapsed-family",
        `家族 ${family?.label || id} 有 ${assessment.residentCount} 个成员恒常驻、${assessment.collectableCount} 个成员可折叠`,
        { family: id, assessment },
      ));
    }
  }

  // ——— D8: config keys that resolve to nothing ————————————————————————————
  for (const key of report?.orphanKeys ?? []) {
    out.push(row(
      "D8",
      "warn",
      "unknown-family-key",
      `配置键 families.${key} 匹配不到任何家族、包或别名（拼写错误，或该插件已卸载）`,
      { key },
    ));
  }
  for (const use of report?.aliasUses ?? []) {
    out.push(row(
      "D8",
      "info",
      "config-alias",
      `配置键 families.${use.key} 已按曾用名生效，实际作用于家族「${use.family}」`,
      { key: use.key, family: use.family },
    ));
  }
  for (const rejection of report?.rejected ?? []) {
    out.push(row(
      "D9",
      "info",
      "id-collision",
      `${rejection.pkg} 的家族名与其他工具/家族冲突（base「${rejection.base}」），该包未被折叠，其工具全部常驻`,
      { package: rejection.pkg },
    ));
  }

  // Worst first, then by id so a snapshot is stable across calls.
  const rank = (severity) => {
    const index = SEVERITIES.indexOf(severity);
    return index < 0 ? SEVERITIES.length : index;
  };
  out.sort((a, b) => rank(a.severity) - rank(b.severity) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}
