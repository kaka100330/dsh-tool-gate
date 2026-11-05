/**
 * Tools that must stay on the wire no matter what. Generated from the live profile.
 *
 * `CORE_TOOLS` here is the *residual* core set: the five session-query tools and
 * the four schedule tools have been moved into builtin families (`session` and
 * `schedule`), so they are no longer unconditional. See `BUILTIN_FAMILY_TOOLS`.
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

/**
 * Builtin families: first-party tool sets that are cheap to defer but expensive
 * to carry. Each family collapses behind its own gateway exactly like a
 * third-party family, and each is switched on its own in the settings page.
 *
 * Membership is an explicit name list because these are shipped tools with
 * stable names — not a package rule, which would also capture `plugin_manager`
 * (a resident control surface) if it were attributed by package.
 */
export const BUILTIN_FAMILY_TOOLS = {
  session: {
    label: "会话检索",
    description: "Search and trace earlier sessions, their events and their lineage",
    tools: [
      "session_search",
      "session_event_search",
      "session_event_read",
      "session_event_trace",
      "session_trace",
    ],
    packages: ["@deepseek-ai/dsh-tool-session-query"],
  },
  schedule: {
    label: "日程",
    description: "Create, list, update and delete scheduled reminders",
    tools: ["schedule_create", "schedule_list", "schedule_update", "schedule_delete"],
    packages: ["@deepseek-ai/dsh-tool-schedule"],
  },
};

/** Every name owned by a builtin family. */
export const BUILTIN_FAMILY_NAMES = new Set(
  Object.values(BUILTIN_FAMILY_TOOLS).flatMap((family) => family.tools),
);
