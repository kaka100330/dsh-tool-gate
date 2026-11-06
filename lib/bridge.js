/**
 * Read-only host routes for the settings page.
 *
 * The auto-generated settings form can edit scalar fields, but the page this
 * plugin wants to show — one row per family with its live member count and token
 * weight, one row per plugin that injects prompt text — cannot be expressed as a
 * schemastery form. So the client asks the host for a snapshot instead.
 *
 * Everything here is a GET with no side effect, and it is guarded the same way
 * `dsh-free-search` guards its bridge: same-origin or loopback only, so a
 * cross-site page cannot enumerate the user's plugins.
 */

import net from "node:net";

import { SELF_PACKAGE_NAME } from "./owner.js";

/** Route prefix; the client appends the action. */
export const BRIDGE_PREFIX = "/api/dsh-tool-gate";

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
  const disclosureFor = (family) => {
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
  const families = Object.values(table)
    .map((family) => {
      const members = membersByFamily?.get(family.id) ?? runtime.membersOf(family.id, scope);
      const familyNames = members.map((schema) => schema.name);
      const bytes = tokensOf(members);
      return {
        id: family.id,
        label: family.label || family.id,
        description: family.description ?? "",
        /**
         * Which layer supplied `description` — `metaOf`/`manifest` (the plugin
         * itself), `hint` (the fallback table in this package), `derived` (the
         * MCP server list), `override` (the user's config) or `none`.
         *
         * Shown in the page so a gateway still eating the fallback table is
         * visible, which is how the "a new plugin has no description" bug gets
         * caught next time instead of waiting for a report.
         */
        descriptionSource: family.descriptionSource ?? "none",
        builtin: family.builtin === true,
        auto: family.auto !== false,
        enabled: family.enabled !== false,
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
        promptDisclosure: disclosureFor(family),
      };
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const collapsed = families.filter((family) => family.enabled);
  const savedTokens = collapsed.reduce((total, family) => total + family.tokens, 0);

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
    const grouped = new Set();
    for (const family of families) {
      for (const pkg of family.packages) grouped.add(pkg);
    }
    const out = [];
    let builtinCount = 0;
    for (const row of runtime.packages?.() ?? []) {
      if (grouped.has(row.package)) continue;
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
      const toolCount = (row.tools ?? []).length;
      // Why this package has no family to switch:
      //  resident  — it has tools, but every one of them is in the keep set, so
      //              discovery deliberately derives no family for it;
      //  no-tools  — it registers nothing; it is a prompt-only plugin;
      //  unowned   — its prose exists but could not be attributed to a package
      //              we could name.
      let reason = "resident";
      if (entry?.family !== undefined) reason = "unowned";
      else if (toolCount === 0) reason = "no-tools";
      out.push({
        package: row.package,
        thirdParty: true,
        reason,
        toolCount,
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

  return {
    schemaVersion: 2,
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
