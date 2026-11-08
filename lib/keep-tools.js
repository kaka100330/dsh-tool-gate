/**
 * Tools that stay on the wire no matter what — as *names only*.
 *
 * This file used to hold three lists, and two of them were wrong in the same way:
 * they were a hand-maintained copy of a fact the registry already knew.
 *
 *  - `OPS_TOOLS` listed **seven** of the eighteen `ops_*` tools. The other eleven
 *    fell through to the family and were collapsed, so one family appeared to hold
 *    18 tools while the line was drawn through the middle of it. It is gone:
 *    `resident.js` derives the whole set from the name prefix plus the owning
 *    package, which is a rule no install can outdate.
 *  - `CONTEXT_TOOLS` is still here, but only as a name-level fallback. The
 *    package rule (`engine-packages.js` `CONTEXT_PACKAGES`) is what classifies
 *    them; this list exists for the case where the owner cannot be read at all,
 *    where the safe direction is "stays on the wire".
 *
 * `CORE_TOOLS` cannot be derived: the harness's own tools are registered from the
 * root context, which reports no owning package, so their name *is* their identity.
 * The residual set is deliberately small — anything that a package can own has been
 * removed from it.
 */
/** Core = shipped first-party tools that stay resident. */
export const CORE_TOOLS = [
  "ask_user_question",
  "cordis_inspect_list",
  "cordis_inspect_query",
  "create_goal",
  "edit",
  "exit_plan_mode",
  "get_goal",
  "interrupt_agent",
  "job_kill",
  "job_list",
  "job_output",
  "list_agents",
  "list_mcp_resource_templates",
  "list_mcp_resources",
  "load_workspace_dependencies",
  "plugin_manager",
  "present",
  "read_image",
  "read_mcp_resource",
  "send_message",
  "skill",
  "subagent",
  "subagent_fork",
  "terminal_close",
  "terminal_list",
  "terminal_open",
  "terminal_read",
  "terminal_send",
  "terminal_signal",
  "todo_write",
  "update_goal",
  "web_fetch",
  "web_search",
  "workflow",
  "working_directory",
  "write",
];

/** Context management (billion-context): needed in every turn, never worth collapsing. */
export const CONTEXT_TOOLS = [
  "acp_cache",
  "acp_status",
  "compress",
  "decompress",
  "search_context",
];
