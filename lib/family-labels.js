/**
 * Display names for auto-derived families.
 *
 * Discovery names a family after the package that owns it, which is correct but
 * reads badly: `session_query` is fine, `dsh_mcp_connector` is not a label you
 * want in a settings page, and `blender_plugin` makes a clumsy tool name.
 *
 * This file supplies **presentation only** — label, description, and an optional
 * shorter gateway name. Membership always comes from the registry, so:
 *
 *  - a plugin missing from this table still works, it just shows its derived id;
 *  - deleting every row costs nothing but prettier names;
 *  - no row here can make a tool belong to a family, or stop one from belonging.
 *
 * That separation is the point: the previous version of this plugin kept the
 * *membership* here, which is why a newly installed plugin stayed exposed until
 * someone edited the source.
 */

/**
 * Package name -> presentation hints. Keyed by package because that is what
 * discovery reads; one package is one family, so this is the precise key.
 */
const BY_PACKAGE = {
  "dsh-blender-plugin": {
    label: "Blender",
    description: "Blender 3D modeling, rendering, QC and delivery",
    gateway: "blender",
  },
  "dsh-mcp-connector": {
    label: "MCP 管理",
    description: "MCP connector management: catalog, connect, policy, tools",
    gateway: "mcp",
  },
  "dsh-image-gen": {
    label: "图像",
    description: "Image generation and editing",
    gateway: "image",
  },
  "dsh-video-storyboard": {
    label: "视频",
    description: "Video storyboards, probes and subtitles",
    gateway: "video",
  },
  "dsh-free-search": {
    label: "搜索",
    description: "Web, platform and domain search",
    gateway: "search",
  },
  "@perrylink/dsh-github": {
    label: "GitHub",
    description: "GitHub repositories, issues, pull requests and reviews",
    gateway: "github",
  },
  "@vectorize-io/hindsight-coding-agents": {
    label: "记忆",
    description: "Repository memory: knowledge pages, capture, recall",
    gateway: "hindsight",
  },
  "@deepseek-ai/dsh-tool-session-query": {
    label: "会话检索",
    description: "Search and trace earlier sessions, their events and their lineage",
    gateway: "session",
  },
  "@deepseek-ai/dsh-tool-schedule": {
    label: "日程",
    description: "Create, list, update and delete scheduled reminders",
  },
};

/** Derived family id -> presentation hints, for entries with no single package. */
const BY_ID = {
  mcp_servers: {
    label: "MCP 服务器",
    description: "Tools exposed by connected MCP servers",
  },
};

/**
 * Presentation hints for one family.
 *
 * @param id - derived family id.
 * @param pkg - the owning package, when there is exactly one.
 * @returns `{ label, description, gateway? }`; `label` falls back to the id.
 */
export function familyLabelHints(id, pkg) {
  const byPackage = pkg === undefined ? undefined : BY_PACKAGE[pkg];
  const byId = BY_ID[id];
  const label = byPackage?.label ?? byId?.label ?? id;
  const description = byPackage?.description ?? byId?.description ?? "";
  const gateway = byPackage?.gateway ?? byId?.gateway;
  return gateway === undefined ? { label, description } : { label, description, gateway };
}

export default { familyLabelHints };
