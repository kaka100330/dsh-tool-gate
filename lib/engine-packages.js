/**
 * The packages that may never own a family, and the ones whose tools are always
 * resident. Both are rules, not per-plugin exemptions: every entry says *why*
 * the package behaves this way, so a future addition can be judged against the
 * reason instead of against a list.
 *
 * Why this file has to exist at all: the ownership channel answers "whose
 * context was this registration made on". That question has two different answers
 * depending on how a plugin registers.
 *
 *  - A plugin that registers from its own context (`ctx.tools.register(…)` inside
 *    `apply`) answers its own package — correct, and that is the common case.
 *  - A plugin that registers *into an agent scope* — `dsh-ops` publishes its file
 *    and shell tools through `entry.ctx.tools.register(…)`, where `entry.ctx` is
 *    derived from the *agent's* context — answers the **host** package that
 *    created that scope (`@deepseek-ai/dsh-agent-loop`). The registrant is the
 *    caller; the nearest entry tag is the host.
 *
 * The second case cannot be told apart from the first by lookups alone, so a
 * package that is known to be machinery — it assembles or hosts other packages'
 * tools and produces none of its own — is not allowed to found a family. Its
 * ownership is downgraded, the verifier looks for the real registrant, and an
 * unresolved case ends as `unknown` and therefore stays on the wire (exposed).
 * Never as a family named after the engine.
 */

/**
 * Packages that host, boot, inject or transport tools but do not produce them.
 *
 * `@deepseek-ai/dsh-agent-loop` is the one this list was written for: before it
 * existed as a rule, all 18 `ops_*` tools were attributed to it and became
 * "Agent Loop", a family whose label means nothing to a user who wanted to switch
 * file access off.
 */
export const ENGINE_PACKAGES = new Set([
  // The agent scope host: creates the scope a plugin may register into.
  "@deepseek-ai/dsh-agent",
  "@deepseek-ai/dsh-agent-loop",
  // The registry itself: a tool registered through framework code walks here.
  "@deepseek-ai/dsh-tools",
  // Assembly, transport and boot: no tools of their own.
  "@deepseek-ai/dsh-system-prompt",
  "@deepseek-ai/dsh-session",
  "@deepseek-ai/dsh-app-boot",
  "@deepseek-ai/dsh-web-app",
  "@deepseek-ai/dsh-base",
  "@deepseek-ai/cordis",
  "@deepseek-ai/cosmokit",
  "@deepseek-ai/schemastery",
]);

/** Whether a package is machinery rather than a tool producer. */
export function isEnginePackage(pkg) {
  return typeof pkg === "string" && ENGINE_PACKAGES.has(pkg);
}

/**
 * Context-management packages. Their tools are needed on every turn (a `compress`
 * that has to be fetched through a gateway is a tool the model calls too late),
 * so they are resident and never form a family.
 */
export const CONTEXT_PACKAGES = new Set(["billion-context", "dsh-context"]);

export function isContextPackage(pkg) {
  return typeof pkg === "string" && CONTEXT_PACKAGES.has(pkg);
}

/**
 * The native file/shell tool set: `dsh-ops` registers `ops_*` through the agent
 * scope, so the prefix is the only reliable evidence that a name belongs to it.
 *
 * The prefix rule is deliberately narrow — the owner must also be `dsh-ops` — so a
 * third party tool that happens to be called `ops_something` is not pinned to the
 * wire by mistake. Getting that wrong costs a few tokens, never a tool: the
 * failure mode of a resident name is "stays on the wire".
 */
export const OPS_PACKAGE = "dsh-ops";
export const OPS_PREFIX = "ops_";

export function isOpsTool(name, pkg) {
  return typeof name === "string" && name.startsWith(OPS_PREFIX) && pkg === OPS_PACKAGE;
}

/** One-line explanation for the settings page, keyed by package. */
export function engineReason(pkg) {
  if (pkg === "@deepseek-ai/dsh-agent-loop" || pkg === "@deepseek-ai/dsh-agent") {
    return "宿主 agent 作用域：插件把工具注册进这个作用域时，归属会被记到这里";
  }
  if (pkg === "@deepseek-ai/dsh-tools") return "工具注册表本身，不是插件";
  return "引擎/装配包：只承载别人的工具，不产出工具";
}

export default {
  ENGINE_PACKAGES,
  CONTEXT_PACKAGES,
  OPS_PACKAGE,
  OPS_PREFIX,
  isEnginePackage,
  isContextPackage,
  isOpsTool,
  engineReason,
};
