/**
 * Read-only host routes for the settings page.
 *
 * The auto-generated settings form can edit scalar fields, but the page this
 * plugin wants to show — one row per family with its live member count and token
 * weight, one row per plugin that injects prompt text — cannot be expressed as a
 * schemastery form. So the client asks the host for a snapshot instead.
 *
 * `/describe` is a read with no side effect. `/describe/refresh` is the one
 * exception, and it is a POST that says so: it drops the scan and ownership
 * caches, because a plugin installed by another process invalidates neither of
 * them from inside this one (see `runtime.refreshInventory`).
 *
 * Both are guarded the same way `dsh-free-search` guards its bridge: same-origin
 * or loopback only, so a cross-site page cannot enumerate the user's plugins or
 * make the host rescan its disk.
 */

import net from "node:net";

import { SELF_PACKAGE_NAME } from "./owner.js";
import { diagnose, worst } from "./diagnostics.js";

/** Route prefix; the client appends the action. */
export const BRIDGE_PREFIX = "/api/dsh-tool-gate";

/**
 * Aliases worth showing on the page.
 *
 * `discovery.js` recognizes eight legacy counter names per family
 * (`subagent2` … `subagent9`), because the old resolver could have produced any of
 * them and a config key that silently stops working is the bug this release is
 * about. Only the first one can ever have existed in practice (the counter started
 * at 2 and only ever incremented on a collision), and printing eight phantom keys
 * would bury the aliases a user can actually write. They all still resolve — this
 * only trims what is rendered.
 */
function displayAliases(family) {
  const base = typeof family?.baseId === "string" ? family.baseId : family?.id;
  const counter = new RegExp(`^${String(base).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([0-9]+)$`);
  let keptCounter = false;
  const out = [];
  for (const alias of family?.aliases ?? []) {
    const match = counter.exec(alias);
    if (match !== null) {
      if (keptCounter || match[1] !== "2") continue;
      keptCounter = true;
    }
    out.push(alias);
  }
  return out;
}

/** Whether this request comes from the local host or a same-origin page. */
function isAllowed(request) {
  const host = request?.headers?.host;
  if (typeof host !== "string" || host === "") return false;
  // A cross-site fetch is a confused-deputy attempt regardless of Host.
  if (request.headers["sec-fetch-site"] === "cross-site") return false;
  const origin = request.headers.origin;
  if (origin !== undefined) {
    try {
      if (new URL(origin).host !== host) return false;
    } catch {
      return false;
    }
  }
  const authority = host.replace(/^\[/, "").replace(/:[0-9]+$/, "");
  const loopback = authority === "127.0.0.1" || authority === "localhost" || authority === "::1" || authority === "0.0.0.0";
  if (loopback) {
    const remote = String(request.socket?.remoteAddress ?? "");
    return net.isIP(remote) === 0
      ? true
      : remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
  }
  // A directly bound non-loopback address: the Host is the bind address itself.
  const local = String(request.socket?.localAddress ?? "");
  if (local !== "" && local !== "0.0.0.0" && local !== "::") return local.endsWith(authority) || authority === local;
  return false;
}

/** Write a JSON response. */
function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

/**
 * Build the snapshot the settings page renders.
 *
 * @param runtime - the plugin runtime object.
 * @param disclosure - the prompt disclosure engine.
 * @param agent - the agent whose scope describes the views (falls back to the
 *   largest frozen surface, since a scoped registration is invisible globally).
 * @returns the page payload.
 */
function describe(runtime, disclosure, agent) {
  const live = runtime.config();
  const table = runtime.families();
  const names = runtime.wireNames?.() ?? [];
  // Member counts must be read from a scope that can actually see scoped
  // registrations; the main-session agent is the one the page is describing.
  const scope = agent ?? runtime.primaryAgent?.();

  /** Approximate token weight of one schema, matching the profile's own estimate (bytes / 3.2). */
  const tokensOf = (value) => Math.round(Buffer.byteLength(JSON.stringify(value), "utf8") / 3.2);

  // One registry read for every family: `schemas()` deep-clones each tool's
  // parameter dictionary, so the per-family call this replaced paid that cost
  // once per family on every page load.
  /**
   * The disclosure answer for one family: can it be switched on, is it on, and
   * if not, why.
   *
   * `reason` and `enabled` are deliberately separate. `reason` describes whether
   * the switch is *usable*; `enabled` is its position. A row that is switched on
   * but cannot currently act (the family is expanded again) must still show a
   * switch that is on — hiding that would make the user's setting invisible, and
   * toggling it off would then look like it did nothing.
   */
  const disclosureFor = (family, memberCount) => {
    // A family with no members has no gateway, so nothing could ever carry its
    // prose back on `list`. Reporting the switch as usable here was an API-level
    // lie that the page hid by filtering empty rows — and the moment the row is
    // shown for any other reason (a diagnostic, a different client), the user is
    // offered a switch that cannot work.
    if (memberCount === 0) {
      return {
        available: false,
        reason: "no-tools",
        chars: 0,
        names: [],
        required: false,
        enabled: live.families?.[family.id]?.promptDisclosure === true,
        hasText: false,
      };
    }
    const rows = (disclosure?.inventory?.() ?? []).filter((row) => row.family === family.id);
    if (rows.length === 0) {
      return {
        available: false,
        reason: "no-prose",
        chars: 0,
        names: [],
        required: false,
        enabled: live.families?.[family.id]?.promptDisclosure === true,
        hasText: false,
      };
    }
    const names = [];
    for (const row of rows) {
      for (const name of row.names ?? []) if (!names.includes(name)) names.push(name);
    }
    names.sort();
    const chars = rows.reduce((total, row) => total + (row.chars ?? 0), 0);
    const available = rows.some((row) => row.disclosureAvailable === true);
    const reasons = [];
    for (const row of rows) for (const reason of row.reasons ?? []) if (!reasons.includes(reason)) reasons.push(reason);
    // The most actionable reason describes the family as a whole: one disclosable
    // entry and one required entry is still a family you can switch on.
    const reason = available
      ? "ready"
      // A family with several packages (a hand-written override) can have rows
      // that disagree; the first non-"nothing to disclose" answer is the one the
      // user can act on, and every row's answer is on the row anyway.
      : reasons.find((entry) => entry !== "no-prose") ?? "no-prose";
    return {
      available,
      reason,
      chars,
      names,
      required: rows.some((row) => row.required === true),
      enabled: rows.some((row) => row.enabled === true),
      hasText: chars > 0,
    };
  };

  const membersByFamily = runtime.membersByFamily?.(scope);
  /**
   * Per-family verdicts from the degenerate rule.
   *
   * This is what makes the card honest: `count` is every member, but only the
   * collectable ones can ever be hidden, and a family that cannot pay for its
   * gateway hides none of them. The page used to sum all members and call it
   * "saved", which promised 18 tools and 7133 tokens for a family where seven were
   * permanent.
   */
  const assessments = runtime.assessments?.(scope);
  /** name -> identity, for the "this row's attribution is doubtful" reason. */
  const identityIndex = (() => {
    const map = new Map();
    for (const entry of runtime.identities?.() ?? []) {
      if (typeof entry?.name === "string" && entry.identity !== undefined) map.set(entry.name, entry.identity);
    }
    return map;
  })();
  const families = Object.values(table)
    .map((family) => {
      const members = membersByFamily?.get(family.id) ?? runtime.membersOf(family.id, scope);
      const familyNames = members.map((schema) => schema.name);
      const bytes = tokensOf(members);
      const assessment = assessments?.get?.(family.id);
      return {
        id: family.id,
        /**
         * The name the model sees, which is the family id unless a `gateway:`
         * override replaced it. Separate from `id` and from `label` on purpose:
         * the three used to be one string, so renaming a family for readability
         * would have moved the wire name.
         */
        wire: family.wire ?? family.id,
        /** The key a user writes in `families.<key>` (aliases still resolve). */
        configKey: family.id,
        /** Other keys this family still answers to — shown as 「曾用名」. */
        aliases: displayAliases(family),
        /** Set when the label had to be qualified to stay unique. */
        labelQualifier: family.labelQualifier,
        label: family.label || family.id,
        description: family.description ?? "",
        /**
         * Which layer supplied `description` — `metaOf`/`manifest` (the plugin
         * itself), `derived` (the MCP server list), `override` (the user's config)
         * or `none`.
         *
         * Shown in the page so a family the host could not describe says so,
         * which is how "a new plugin has no description" gets caught instead of
         * waiting for a report.
         */
        descriptionSource: family.descriptionSource ?? "none",
        builtin: family.builtin === true,
        auto: family.auto !== false,
        enabled: family.enabled !== false,
        /**
         * Whether this family is actually collapsed right now: on, and worth a
         * gateway. An enabled family whose members are all resident (or too small
         * to pay for the gateway) is *not* collapsed — the switch is on, nothing is
         * behind it — and the page says so instead of listing phantom savings.
         */
        collapsed: family.enabled !== false && (assessment?.worth ?? true),
        /**
         * The degenerate verdict in numbers, so the page can explain itself:
         * 「可折叠 1/3 个成员，节省 140 tok，网关成本 150 tok（需要 3×）」.
         */
        collapsible: assessment === undefined ? undefined : {
          collectableCount: assessment.collectableCount,
          residentCount: assessment.residentCount,
          collectableTokens: assessment.collectableTokens,
          cost: assessment.cost,
          saving: assessment.saving,
          threshold: assessment.threshold,
          ratio: assessment.ratio,
          worth: assessment.worth,
          forced: assessment.forced,
          reason: assessment.reason,
        },
        /**
         * A family with no members has nothing behind its gateway.
         *
         * It happens when a package is named by a family definition or a config
         * override but registers no tool of its own — a plugin that only injects
         * prompt text, or a table entry that outlived its plugin. Showing it as
         * "collapsed, 0 tools" reads like the plugin is broken, so the page
         * hides it; the toggle stays functional because the family is still
         * configurable by id.
         */
        hidden: members.length === 0,
        count: members.length,
        tokens: bytes,
        members: familyNames,
        gateway: runtime.gatewayNameFor(family.id),
        packages: [...(family.packages ?? [])],
        prefixes: [...(family.prefixes ?? [])],
        /**
         * The prompt switch for this family — inline, because a family and its
         * package are one entity (discovery derives one family per package).
         * Two lists meant answering the same question twice, in two places,
         * about the same thing.
         */
        promptDisclosure: disclosureFor(family, members.length),
      };
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  /**
   * What the gate actually saves, this snapshot.
   *
   * Not the sum of every member's tokens — that is what the page used to print, and
   * it promised 18 tools and 7133 tokens for a family where seven members were
   * resident forever and eleven were the real (smaller) prize. The honest number is
   * the sum of each collapsed family's `saving`: collectable members minus the
   * gateway's own cost. A family that cannot pay for its gateway contributes zero,
   * because it is not collapsed at all.
   */
  const collapsed = families.filter((family) => family.collapsed === true);
  const savedTokens = collapsed.reduce(
    (total, family) => total + Math.max(0, family.collapsible?.saving ?? family.tokens),
    0,
  );

  /**

  /**
   * Packages that exist but have no family to switch, and their prompt weight.
   *
   * These are the rows the old second list rendered as greyed-out switches. They
   * are listed here, read-only, precisely so that "this plugin injects 1056
   * characters you cannot switch off" stays visible instead of looking like the
   * plugin forgot about it. A package lands here when its tools are all resident
   * (so discovery derives no family), when it registers no tool at all (a
   * prompt-only plugin), or when nobody could attribute its prose.
   */
  const ungrouped = (() => {
    const prose = new Map((disclosure?.inventory?.() ?? []).map((row) => [row.package, row]));
    /** package -> the family claiming it, so a row can say *who* claims it. */
    const claimedBy = new Map();
    for (const family of families) {
      for (const pkg of family.packages) claimedBy.set(pkg, family);
    }
    const out = [];
    let builtinCount = 0;
    for (const row of runtime.packages?.() ?? []) {
      const claim = claimedBy.get(row.package);
      // Claimed *and* collapsed: the tools are behind that gateway, so there is
      // nothing to report here. Claimed but not collapsed (all resident, or not
      // worth a gateway) is exactly what this list exists to explain.
      if (claim !== undefined && claim.collapsed === true) continue;
      if (row.package === SELF_PACKAGE_NAME) continue;
      // First-party packages are not this list's business: they are never sent to
      // the wire from here and never governed by a switch in this page. Listing
      // them buried the few rows that do matter — 31 of 38 measured rows were
      // harness-internal. The count is still reported, so the page can say the
      // packages exist instead of pretending it found nothing.
      if (row.thirdParty === false) {
        builtinCount += 1;
        continue;
      }
      const entry = prose.get(row.package);
      const toolNames = [...(row.tools ?? [])];
      const toolCount = toolNames.length;
      /**
       * Why this package has no family to switch — **derived from evidence**, one
       * row per fact, never a default.
       *
       * The old code defaulted to `"resident"` and only overwrote it in two cases,
       * so a package whose tools were behind a gateway was described as "all its
       * tools are resident". That sentence is what sent the user looking for a
       * plugin the page said could not be collapsed.
       */
      const residentTools = toolNames.filter((name) => runtime.isResident?.(name) === true);
      const weak = toolNames.filter((name) => identityIndex.get(name)?.confidence === "low");
      let reason;
      if (claim !== undefined) reason = "claimed";
      else if (weak.length > 0 && weak.length === toolCount) reason = "misattributed";
      else if (toolCount === 0) reason = "no-tools";
      else if (residentTools.length === toolCount) reason = "no-collapsible-members";
      else if (entry?.family !== undefined) reason = "unowned";
      // Tools exist, none resident, no family: attribution could not name an owner.
      else reason = "unowned";
      out.push({
        package: row.package,
        thirdParty: true,
        reason,
        toolCount,
        /** How many of those tools are resident by rule (never collapsible). */
        residentCount: residentTools.length,
        /** The tool names themselves — D3 checks this row against the predicate. */
        tools: toolNames,
        /** The family that claims this package, when one does. */
        family: claim?.id,
        chars: entry?.chars ?? 0,
        names: entry?.names ?? [],
        // Always null: there is no switch to flip. Reporting a boolean here
        // would invite the page to render one that does nothing.
        enabled: null,
      });
    }
    out.sort((a, b) => (a.package < b.package ? -1 : a.package > b.package ? 1 : 0));
    return { rows: out, builtinCount };
  })();

  /**
   * The consistency self-check (D1–D8 in `diagnostics.js`).
   *
   * Computed here rather than in a route of its own because it has to check the
   * rows the page actually renders — `ungrouped` in particular, whose `reason` was
   * the false statement at the heart of one of the three bugs.
   */
  const diagnostics = (() => {
    try {
      const inputs = runtime.diagnosticsInputs?.(scope);
      if (inputs === undefined) return [];
      return diagnose({ ...inputs, ungrouped: ungrouped.rows });
    } catch {
      // A page that shows counts must never throw; a failed self-check is reported
      // as an empty list rather than as a broken settings page.
      return [];
    }
  })();

  return {
    schemaVersion: 3,
    enabled: live.enabled === true,
    builtinFamilies: live.builtinFamilies !== false,
    autoFamilies: live.autoFamilies !== false,
    promptDisclosure: live.promptDisclosure === true,
    wireToolCount: names.length,
    savedTokens,
    families,
    ungrouped: ungrouped.rows,
    /** How many first-party packages were left out of `ungrouped` (see above). */
    ungroupedBuiltin: ungrouped.builtinCount,
    /**
     * The self-check rows, worst severity first. An empty list is the healthy
     * answer; the page shows a badge only when it is not.
     */
    diagnostics,
    /** Worst severity present (`error` / `warn` / `info`), or null when clean. */
    diagnosticsWorst: worst(diagnostics) ?? null,
    config: {
      listDetail: live.listDetail !== false,
      staticNotice: live.staticNotice !== false,
      interceptDirectCalls: live.interceptDirectCalls !== false,
      guardFallback: live.guardFallback !== false,
      concurrencyDelegate: live.concurrencyDelegate === true,
      freeze: live.freeze !== false,
      unknownOwnerPolicy: live.unknownOwnerPolicy === "collapse" ? "collapse" : "expose",
      diskScan: live.diskScan === "off" ? "off" : "on",
      gatewayPrefix: live.gatewayPrefix ?? "",
      /** `k` in the degenerate rule, so the page can explain a suppressed family. */
      degenerateThreshold: live.degenerateThreshold ?? 3,
      verifyAttribution: live.verifyAttribution !== false,
    },
  };
}

/**
 * Register the routes.
 *
 * `ctx` must be a context that has `webServer` injected (see the `ctx.inject`
 * call in `index.js`): the service is composed after this plugin mounts, so
 * resolving it eagerly at `apply` time would usually find nothing.
 *
 * @param ctx - a context with `webServer` in scope.
 * @param options.runtime - the plugin runtime object (must expose `config`,
 *   `families`, `gatewayNameFor`, `membersOf`, and optional `wireNames`).
 * @param options.disclosure - the prompt disclosure engine.
 * @param options.logger - optional logger.
 * @returns a disposer, or undefined when this build has no webserver.
 */
export function registerBridge(ctx, options) {
  const { runtime, disclosure, logger } = options;
  let server;
  try {
    server = ctx.webServer ?? ctx.get("webServer", false);
  } catch {
    server = undefined;
  }
  if (server === undefined || typeof server.register !== "function") {
    logger?.debug?.("dsh-tool-gate: no webServer service; the settings page runs without a live inventory");
    return undefined;
  }

  const disposers = [];
  const route = (path, handler) => {
    try {
      disposers.push(server.register({ kind: "exact", path: `${BRIDGE_PREFIX}${path}`, handler }));
    } catch (error) {
      logger?.warn?.(`dsh-tool-gate: could not register ${path} (${String(error?.message ?? error)})`);
    }
  };

  route("/describe", (req, res) => {
    if (req.method !== "GET" && req.method !== "POST") {
      send(res, 405, { ok: false, error: "method not allowed" });
      return;
    }
    if (!isAllowed(req)) {
      send(res, 403, { ok: false, error: "requests must come from the local host or a same-origin page" });
      return;
    }
    try {
      send(res, 200, { ok: true, value: describe(runtime, disclosure, runtime.primaryAgent?.()) });
    } catch (error) {
      send(res, 500, { ok: false, error: String(error?.message ?? error) });
    }
  });

  /**
   * Re-derive the inventory from disk, then answer with a fresh snapshot.
   *
   * This exists because "Refresh" in the page used to re-issue the same GET, which
   * re-read three caches that never move when a plugin is installed by another
   * process: the scan index, the owner memo and the family signature. The user's
   * report was exactly that — stop or start a plugin, press refresh, and the list
   * does not change until the next session.
   *
   * POST only. It is not a display read any more: it drops caches, so it must not
   * be reachable as a side-effecting GET (link prefetch, a camera, an `<img>`),
   * and `isAllowed` still confines it to the local host or a same-origin page.
   * The response has the same shape as `/describe`, so the page can swap its
   * snapshot in place instead of reloading.
   */
  route("/describe/refresh", (req, res) => {
    if (req.method !== "POST") {
      send(res, 405, { ok: false, error: "method not allowed" });
      return;
    }
    if (!isAllowed(req)) {
      send(res, 403, { ok: false, error: "requests must come from the local host or a same-origin page" });
      return;
    }
    try {
      runtime.refreshInventory?.();
      send(res, 200, { ok: true, value: describe(runtime, disclosure, runtime.primaryAgent?.()) });
    } catch (error) {
      send(res, 500, { ok: false, error: String(error?.message ?? error) });
    }
  });

  return () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose();
      } catch {
        /* already gone */
      }
    }
  };
}
