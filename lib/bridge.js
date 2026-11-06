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

import { isHarnessPackage } from "./ownership-channel.js";

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
      };
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const collapsed = families.filter((family) => family.enabled);
  const savedTokens = collapsed.reduce((total, family) => total + family.tokens, 0);

  /**
   * Tools that are on the wire and in no family.
   *
   * The families list answers "what did we collapse"; this answers "what did we
   * leave alone, and why". Without it the page cannot distinguish the three very
   * different cases — a resident tool (by design), a family with no members (a
   * stale derivation), and a tool nobody could attribute (`unknownOwnerPolicy`
   * decided) — and every one of them looks like the plugin silently doing
   * nothing.
   */
  const ungrouped = (() => {
    const out = [];
    let wire = new Set(names);
    try {
      const view = runtime.ctx?.tools?.view?.(scope);
      if (view?.visible !== undefined) wire = new Set(view.visible.keys());
    } catch {
      /* fall back to the frozen surface's names */
    }
    const residentSet = new Set(runtime.residentNames?.() ?? []);
    for (const name of wire) {
      if (runtime.familyOf?.(name) !== undefined) continue;
      let reason = "unowned";
      if (residentSet.has(name)) reason = "resident";
      else if (name.startsWith("mcp__")) reason = "mcp";
      out.push({ name, reason });
    }
    out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return out;
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
    ungrouped,
    /**
     * The switch list. One row per package, including plugins that contribute no
     * prose yet: the point is that a future injection needs no code change here.
     * `chars` is what that package currently contributes (0 when nothing), so the
     * page can sort or grey out without guessing.
     */
    plugins: (() => {
      const prose = new Map(disclosure.inventory().map((row) => [row.package, row]));
      const table = new Map();
      for (const row of runtime.packages?.() ?? []) table.set(row.package, row);
      for (const [pkg, row] of prose) {
        if (!table.has(pkg)) {
          table.set(pkg, { package: pkg, thirdParty: !isHarnessPackage(pkg), families: [], tools: [] });
        }
        table.get(pkg).prose = row;
      }
      const out = [];
      for (const row of table.values()) {
        const entry = row.prose;
        out.push({
          package: row.package,
          thirdParty: row.thirdParty !== false,
          families: entry?.family !== undefined ? [...new Set([...row.families, entry.family])] : row.families,
          toolCount: row.tools.length,
          names: entry?.names ?? [],
          required: entry?.required === true,
          chars: entry?.chars ?? 0,
          // A switch is only honest when turning it on does something today.
          disclosureAvailable: entry?.disclosureAvailable === true,
          // …and when it does not, say which precondition is missing.
          reason: entry?.reason ?? "no-prose",
          hasText: entry?.hasText === true,
          enabled: live.promptPlugins?.[row.package]?.enabled === true,
        });
      }
      out.sort((a, b) => (a.package < b.package ? -1 : a.package > b.package ? 1 : 0));
      return out;
    })(),
    promptPlugins: live.promptPlugins ?? {},
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
