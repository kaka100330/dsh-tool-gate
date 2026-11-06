/**
 * Tools that must stay on the wire no matter what. Generated from the live profile.
 *
 * `CORE_TOOLS` here is the *residual* core set: the five session-query tools and
 * the four schedule tools now collapse like any other optional tool, derived from
 * their packages — so they are no longer unconditional. Nothing about them is
 * listed here; see `discovery.js`.
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

/** OPS = the native file/shell tool set (dsh-ops). */
export const OPS_TOOLS = [
  "ops_bash",
  "ops_discover_tools",
  "ops_glob",
  "ops_grep",
  "ops_inspect_local_file",
  "ops_read_files",
  "ops_result",
];

/** Context management (billion-context): needed in every turn, never worth collapsing. */
export const CONTEXT_TOOLS = [
  "acp_cache",
  "acp_status",
  "compress",
  "decompress",
  "search_context",
];
