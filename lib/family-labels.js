/**
 * Cosmetic hints for auto-derived families: a short label and, secondarily, a
 * gateway name.
 *
 * Descriptions are no longer written here. They come from the host
 * (`lib/plugin-meta.js` reads the same `pluginPackages` service the settings page
 * uses), because a hand-written sentence drifts: the `github` row below still
 * says "repositories, issues, pull requests and reviews" while the package talks
 * about PR review automation and a CI gate. The `description` values kept here
 * are therefore **fallbacks**, used only when the host knows nothing about the
 * package — which in practice means a first-party package whose manifest
 * describes the module rather than the plugin.
 *
 * A label is worth keeping for the packages where the derived id reads badly:
 * `free_search` should say 搜索, not `Free Search`. Everything else falls through
 * to the host's localized title and then to a humanized id, so a plugin nobody
 * listed here still gets a readable name.
 *
 * Presentation only. Membership always comes from the registry, so a plugin
 * missing from this table still works, deleting every row costs nothing but
 * prettier names, and no row can make a tool belong to a family or stop one from
 * belonging. That separation is the point: the previous version of this plugin
 * kept the *membership* here, which is why a newly installed plugin stayed
 * exposed until someone edited the source.
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

/** `computer_use_win` -> `Computer Use Win`; the last label layer, no table. */
function humanizeLabel(id) {
  const words = String(id ?? "").split("_").filter((word) => word !== "");
  if (words.length === 0) return String(id ?? "");
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

/**
 * Presentation hints for one family.
 *
 * The label falls through four layers, in this order:
 *
 *  1. this table's short name — `github` → `GitHub`, `free_search` → `搜索`;
 *  2. the host's localized title, but only when it is not merely the package
 *     name (third-party packages usually report exactly that, so using it would
 *     turn `GitHub` into `@perrylink/dsh-github`);
 *  3. a humanized id — `computer_use_win` → `Computer Use Win`.
 *
 * A configured `families.<id>.label` still wins over all of it, applied later by
 * `applyFamilyOverrides`. The gateway name is unaffected: it is derived from the
 * family id and is part of the wire surface, so it never follows a title.
 *
 * @param id - derived family id.
 * @param pkg - the owning package, when there is exactly one.
 * @param meta - optional host metadata: `{ title?: string }`.
 * @returns `{ label, description, gateway? }`.
 */
export function familyLabelHints(id, pkg, meta) {
  const byPackage = pkg === undefined ? undefined : BY_PACKAGE[pkg];
  const byId = BY_ID[id];
  const label = byPackage?.label ?? byId?.label ?? meta?.title ?? humanizeLabel(id);
  const description = byPackage?.description ?? byId?.description ?? "";
  const gateway = byPackage?.gateway ?? byId?.gateway;
  return gateway === undefined ? { label, description } : { label, description, gateway };
}

export default { familyLabelHints };
