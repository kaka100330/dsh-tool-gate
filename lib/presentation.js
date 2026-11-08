/**
 * Tool disclosure on hosts where tool declarations are provider-owned.
 *
 * DSH <= 0.2.1 assembled the wire from the `system-prompt/assemble` waterfall and
 * honoured a listener that replaced `assembly.tools`. DSH 0.2.2 moved tool
 * declarations to the provider: the payload carries sections, contexts and
 * variables only, and the host re-attaches the provider's own list afterwards
 * (`return { ...transformed, tools }`). Replacing `tools` there is silently
 * discarded.
 *
 * The seam that is still open is the per-scope tool executor. `ToolsService`
 * builds the wire from exactly one provider --
 *
 *     ctx.systemPrompt.tools(({ scope, toolSet }) =>
 *       this.selectExecutor(scope).describe(this.definitions(scope, toolSet)))
 *
 * -- and `selectExecutor(scope)` walks the scope chain, so an agent that installs
 * its own executor wins over the deployment default. Only `describe()` is
 * filtered here. `execute()` delegates to the executor this one wraps, so a
 * collapsed member keeps running: execution resolves through the registry, not
 * through the wire, and pre-execute policy, guards and session logging are all
 * untouched.
 *
 * Nothing in this module mutates the registry: no `restrict()`, no conditional
 * registration. A member that is hidden from the wire is still visible to
 * `tools.schemas()` -- that is what `action: "list"` reads -- and still callable
 * through the gateway.
 */

/**
 * The PTC transport. It is the *only* tool a collapsed scope receives, so
 * hiding it would leave that scope with nothing at all.
 */
const RUN_CODE = "run_code";

/**
 * Remove the hidden names from one `describe()` input.
 *
 * The input is the array of tool *definitions* the provider collected for this
 * step (`tools.definitions(scope, toolSet)`), not schemas, so only `name` is
 * consulted. An empty set returns the same array reference, which keeps the
 * common case allocation-free.
 *
 * @param tools - definitions as handed to `describe`.
 * @param hidden - names that must not reach the wire.
 * @returns the same array, or a filtered copy.
 */
export function withoutHidden(tools, hidden) {
  if (!Array.isArray(tools) || hidden === undefined || hidden.size === 0) return tools;
  return tools.filter((definition) => definition?.name === RUN_CODE || !hidden.has(definition.name));
}

/**
 * Build the per-agent filter installer.
 *
 * The returned function is idempotent: the first call for an agent installs the
 * wrapper and stores `{ hidden, dispose }` on that agent's state; later calls
 * return the same object so the caller can mutate `hidden` in place. Installing
 * once and mutating the set is what keeps the wire byte-stable -- replacing the
 * executor between turns would re-register the provider's section and change
 * the bytes the prompt cache keys on.
 *
 * @param options.logger - plugin logger.
 * @returns `(agent, state) => { hidden, dispose } | undefined`.
 */
export function createExecutorFilter(options) {
  const { logger } = options ?? {};

  return (agent, state) => {
    if (state === undefined || state === null) return undefined;
    if (state.executorFilter !== undefined) return state.executorFilter;

    // Reading `agent.ctx.tools` can *throw*: Cordis raises "cannot get property
    // \"tools\" without inject" for a context that never declared it. This runs
    // inside the assemble waterfall, where a throw would take the whole turn
    // down, so the lookup is guarded rather than assumed.
    let service;
    try {
      service = agent?.ctx?.tools;
    } catch (error) {
      logger?.debug?.(`dsh-tool-gate: agent scope exposes no tools service (${String(error?.message ?? error)})`);
      return undefined;
    }
    if (service === undefined || service === null) {
      // No agent scope: an unscoped `setExecutor` would mask every agent, and
      // this plugin must never do that.
      return undefined;
    }
    if (typeof service.setExecutor !== "function" || typeof service.selectExecutor !== "function") {
      logger?.debug?.(
        "dsh-tool-gate: this host has no per-scope tool executor; progressive disclosure is unavailable",
      );
      return undefined;
    }

    // Resolve the executor this one wraps *before* installing: afterwards
    // `selectExecutor(agent)` returns the wrapper itself.
    let ambient;
    try {
      ambient = service.selectExecutor(agent);
    } catch (error) {
      logger?.debug?.(`dsh-tool-gate: no ambient executor for this agent (${String(error?.message ?? error)})`);
      return undefined;
    }
    if (ambient === undefined || ambient === null) return undefined;

    const hidden = new Set();
    const wrapper = {
      describe(tools) {
        return ambient.describe(withoutHidden(tools, hidden));
      },
      execute(input) {
        return ambient.execute(input);
      },
      // The host registers an executor's prompt sections and gates each on
      // "is this still the selected executor?". Dropping the wrapped executor's
      // sections would silently remove its prompt text (the PTC transport
      // section, for one), so they are passed through unchanged.
      ...(Array.isArray(ambient.sections) ? { sections: ambient.sections } : {}),
    };

    try {
      const dispose = service.setExecutor(wrapper);
      state.executorFilter = { hidden, dispose };
      return state.executorFilter;
    } catch (error) {
      // "Only one tool executor may be registered in each scope" lands here if
      // another plugin already owns this agent's disclosure. Degrading to "no
      // collapse" is correct: showing every tool costs tokens, hiding tools the
      // user cannot then reach costs correctness.
      logger?.warn?.(
        `dsh-tool-gate: could not take over tool disclosure for this agent (${String(error?.message ?? error)})`,
      );
      return undefined;
    }
  };
}

export default createExecutorFilter;
