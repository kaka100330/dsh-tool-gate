/**
 * Per-agent gate state, plus the session plugin record that survives compaction,
 * resume and fork.
 *
 * A record only ever stores tool *names*. Schemas are rebuilt from the live
 * registry on demand, so a resumed session never inherits a stale parameter
 * shape from a previous plugin version.
 *
 * Record payload:
 *   { schemaVersion: 2,
 *     agents: [{ id, names: string[], collapsed: string[], createdAt }] }
 *
 * Version 1 is read as-is: the agent row shape did not change, only the set of
 * names that can appear in it (gateways are now excluded from attribution, so a
 * resumed session may see fewer). Refusing to read v1 would silently un-collapse
 * every family in a session resumed across the upgrade, which is a worse outcome
 * than reading a payload whose shape we still understand.
 */

export const RECORD_STATE = "plugin:tool-gate/state";
export const RECORD_DISPATCH = "plugin:tool-gate/dispatch";
export const RECORD_DRIFT = "plugin:tool-gate/drift";
export const RECORD_SCHEMA_VERSION = 2;

/** Oldest record layout this build can still read. */
const MIN_READABLE_VERSION = 1;

/** Maximum agent rows kept in one record; older rows are dropped first. */
const MAX_RECORDED_AGENTS = 32;

/**
 * The session package's plugin-record helpers, injected once by `apply`.
 *
 * They live at module scope rather than on `ctx` so nothing else has to know the
 * plugin put them there, and so a failed import degrades to "records are skipped"
 * instead of a crash.
 */
let sessionApi = {};

/** Install the session helpers (called once from `apply`). */
export function configureSessionApi(api) {
  sessionApi = api ?? {};
}

/**
 * Gate state for one agent.
 *
 * `frozen` is the ordered schema array handed to the provider. Once set it is
 * never recomputed in the same session unless the user turns `freeze` off, which
 * is what makes the wire prefix byte-stable.
 */
export class AgentState {
  constructor(agent) {
    this.agent = agent;
    this.id = String(agent?.id ?? "");
    /** Frozen wire schemas, or undefined before the first assembly. */
    this.frozen = undefined;
    /** Collapsed names at freeze time, in wire order of discovery. */
    this.collapsed = [];
    /** Fast lookup for the interception layers. */
    this.collapsedNames = new Set();
    /** Whether the freeze is final for this session. */
    this.ready = false;
    /** Families whose definitions were already returned by `list` in this session. */
    this.listed = new Set();
    /** Monotonic counter for gateway sub-call ids. */
    this.seq = 0;
    /** Set once PTC presentation is detected for this agent. */
    this.ptc = false;
    /** Set when the static notice has been appended for this agent. */
    this.noticeAdded = false;
    /** How many times the frozen surface was rebuilt (diagnostics). */
    this.freezes = 0;
    /**
     * Prompt contributions withheld from the prefix, per family:
     * `{ [familyId]: [{ name, kind, text }] }`. Captured on the way out of the
     * assembly so `action: "list"` can hand the same text back verbatim.
     */
    this.promptText = {};
    /** Families whose prompt text was already disclosed in this session. */
    this.promptDisclosed = new Set();
    /**
     * Per-agent wire filter on hosts where tool declarations are provider-owned
     * (`presentation.js`): the hidden-name set `describe()` filters by, plus the
     * disposer that gives the agent its previous executor back.
     */
    this.executorFilter = undefined;
    /**
     * Identity of the registry the current surface was computed from. On hosts
     * where the provider owns declarations the surface has to be recomputed when
     * the registry changes (a plugin installed, a gateway mounted), but must stay
     * byte-identical when it did not — this is that comparison.
     */
    this.surfaceSignature = undefined;
  }

  /** Adopt one surface: keep both the list and the lookup set in step. */
  adopt(frozen, collapsed) {
    this.frozen = frozen;
    this.collapsed = [...collapsed];
    this.collapsedNames = new Set(collapsed);
    this.ready = true;
    this.freezes += 1;
  }

  /** Release the wire filter, restoring the executor this agent wrapped. */
  releaseExecutorFilter() {
    const filter = this.executorFilter;
    this.executorFilter = undefined;
    if (filter === undefined) return;
    try {
      filter.dispose?.();
    } catch {
      /* the scope is already gone */
    }
  }

  nextCallId(parentCallId) {
    this.seq += 1;
    return `${parentCallId}:gw:${this.seq}`;
  }
}

/** WeakMap<Agent, AgentState> — a fork or resume produces a new Agent instance, so states never leak across agents. */
export function createStateStore() {
  const states = new WeakMap();
  /** Kept separately so diagnostics can enumerate without leaking agent references. */
  const order = new Set();

  return {
    get(agent) {
      return agent === undefined ? undefined : states.get(agent);
    },
    ensure(agent) {
      if (agent === undefined || agent === null) return undefined;
      const existing = states.get(agent);
      if (existing !== undefined) return existing;
      const created = new AgentState(agent);
      states.set(agent, created);
      order.add(created);
      return created;
    },
    delete(agent) {
      const existing = agent === undefined ? undefined : states.get(agent);
      if (existing === undefined) return false;
      order.delete(existing);
      states.delete(agent);
      return true;
    },
    [Symbol.iterator]() {
      return order[Symbol.iterator]();
    },
    get size() {
      return order.size;
    },
  };
}

/** Read the latest gate record from a session, if the session service exposes its log. */
export function readGateRecord(session) {
  const { pluginRecordOf } = sessionApi;
  if (session === undefined || pluginRecordOf === undefined) return undefined;
  let log;
  try {
    log = Array.isArray(session.log) ? session.log : undefined;
  } catch {
    return undefined;
  }
  if (log === undefined) return undefined;
  for (let index = log.length - 1; index >= 0; index -= 1) {
    let record;
    try {
      record = pluginRecordOf(log[index]);
    } catch {
      continue;
    }
    if (record === undefined || record.type !== RECORD_STATE) continue;
    const data = record.data;
    if (data === null || typeof data !== "object") return undefined;
    const version = Number(data.schemaVersion ?? MIN_READABLE_VERSION);
    if (!Number.isFinite(version) || version < MIN_READABLE_VERSION) return undefined;
    return data;
  }
  return undefined;
}

/** Find one agent's row inside a gate record. */
export function agentRowOf(record, agentId) {
  if (record === null || typeof record !== "object") return undefined;
  const agents = Array.isArray(record.agents) ? record.agents : [];
  return agents.find((row) => row !== null && typeof row === "object" && row.id === agentId);
}

/**
 * Append (or refresh) one agent's row in the session's gate record.
 *
 * Failures are swallowed: the record is a convenience for resume diagnostics and
 * for a later "what was collapsed" answer, never a correctness dependency, and a
 * third-party caller may be refused by the plugin-record track on some builds.
 */
export function writeGateRecord(session, agentState, names, logger) {
  const append = sessionApi.appendPluginRecord;
  if (session === undefined || typeof append !== "function") return false;
  try {
    const previous = readGateRecord(session);
    const rows = Array.isArray(previous?.agents) ? previous.agents.filter((row) => row?.id !== agentState.id) : [];
    rows.push({
      id: agentState.id,
      names: [...names],
      collapsed: [...agentState.collapsed],
      createdAt: Date.now(),
    });
    append(session, RECORD_STATE, {
      schemaVersion: RECORD_SCHEMA_VERSION,
      agents: rows.slice(-MAX_RECORDED_AGENTS),
    });
    return true;
  } catch (error) {
    logger?.debug?.(`dsh-tool-gate: could not persist gate record (${String(error?.message ?? error)})`);
    return false;
  }
}

/** Append one dispatch diagnostic line. Never throws. */
export function writeDispatchRecord(session, payload, logger) {
  const append = sessionApi.appendPluginRecord;
  if (session === undefined || typeof append !== "function") return;
  try {
    append(session, RECORD_DISPATCH, payload);
  } catch (error) {
    logger?.debug?.(`dsh-tool-gate: could not persist dispatch record (${String(error?.message ?? error)})`);
  }
}

/** Append one attribution-drift diagnostic line. Never throws. */
export function writeDriftRecord(session, payload, logger) {
  const append = sessionApi.appendPluginRecord;
  if (session === undefined || typeof append !== "function") return;
  try {
    append(session, RECORD_DRIFT, payload);
  } catch (error) {
    logger?.debug?.(`dsh-tool-gate: could not persist drift record (${String(error?.message ?? error)})`);
  }
}
