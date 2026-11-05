import { CORE_TOOLS, OPS_TOOLS, CONTEXT_TOOLS, BUILTIN_FAMILY_TOOLS } from "./keep-tools.js";

/**
 * Family definitions and the frozen wire surface (F0).
 *
 * A family is a named bucket of tools that all collapse behind one gateway tool.
 *
 * Third-party families take membership from the owner package (exact
 * `package.json` name) or a tool-name prefix — never an enumerated list, because
 * their members change as plugins update.
 *
 * Builtin families (first-party tool sets such as session search and scheduling)
 * take membership from an explicit name list: they ship with stable names, and a
 * package rule would capture resident control surfaces from the same package.
 * `builtin: true` marks them so one master switch can turn the whole group off.
 */

/** Built-in families. `cordis.patch.yml` ships the same table so a user can edit it in the profile. */
export const DEFAULT_FAMILIES = {
  blender: {
    label: "Blender",
    description: "Blender 3D modeling, rendering, QC and delivery",
    enabled: true,
    packages: ["dsh-blender-plugin"],
    prefixes: [],
  },
  mcp: {
    label: "MCP 管理",
    description: "MCP connector management: catalog, connect, policy, tools",
    enabled: true,
    packages: ["dsh-mcp-connector"],
    prefixes: [],
  },
  mcp_servers: {
    label: "MCP 服务器",
    description: "Tools exposed by connected MCP servers",
    enabled: true,
    packages: [],
    prefixes: ["mcp__"],
  },
  github: {
    label: "GitHub",
    description: "GitHub repositories, issues, pull requests and reviews",
    enabled: true,
    packages: ["@perrylink/dsh-github"],
    prefixes: [],
  },
  image: {
    label: "图像",
    description: "Image generation and editing",
    enabled: true,
    packages: ["dsh-image-gen"],
    prefixes: [],
  },
  video: {
    label: "视频",
    description: "Video storyboards, probes and subtitles",
    enabled: true,
    packages: ["dsh-video-storyboard"],
    prefixes: [],
  },
  search: {
    label: "搜索",
    description: "Web, platform and domain search",
    enabled: true,
    packages: ["dsh-free-search"],
    prefixes: [],
  },
  hindsight: {
    label: "记忆",
    description: "Repository memory: knowledge pages, capture, recall",
    enabled: true,
    packages: ["@vectorize-io/hindsight-coding-agents"],
    prefixes: [],
  },
  // Builtin families: first-party tool sets, membership by explicit name list.
  // `packages` is carried too, so prompt disclosure can find the owning plugin
  // without a second lookup table.
  ...Object.fromEntries(
    Object.entries(BUILTIN_FAMILY_TOOLS).map(([id, family]) => [
      id,
      {
        label: family.label,
        description: family.description,
        enabled: true,
        builtin: true,
        packages: [...(family.packages ?? [])],
        prefixes: [],
        tools: [...family.tools],
      },
    ]),
  ),
};

/** Family ids that belong to the builtin group. */
export const BUILTIN_FAMILY_IDS = new Set(Object.keys(BUILTIN_FAMILY_TOOLS));

/** Tool names that are gateways themselves — never treated as family members. */
export const GATEWAY_NAMES = new Set(
  Object.keys(DEFAULT_FAMILIES).map((id) => id),
);

const CORE = new Set(CORE_TOOLS);
const OPS = new Set(OPS_TOOLS);
const CONTEXT = new Set(CONTEXT_TOOLS);

/** Names that stay on the wire regardless of attribution. */
export function isKeepTool(name) {
  return CORE.has(name) || OPS.has(name) || CONTEXT.has(name);
}

/** Merge the configured family table over the defaults (config wins per family, not wholesale). */
export function resolveFamilies(configFamilies, options = {}) {
  const builtinEnabled = options.builtinEnabled !== false;
  const merged = {};
  const ids = new Set([...Object.keys(DEFAULT_FAMILIES), ...Object.keys(configFamilies ?? {})]);
  for (const id of ids) {
    const base = DEFAULT_FAMILIES[id] ?? { label: id, description: "", enabled: true, packages: [], prefixes: [] };
    const override = configFamilies?.[id];
    const patched = override !== undefined && override !== null && typeof override === "object";
    const isBuiltin = base.builtin === true;
    const ownEnabled = patched && typeof override.enabled === "boolean" ? override.enabled : base.enabled;
    merged[id] = {
      id,
      label: patched && typeof override.label === "string" && override.label !== "" ? override.label : base.label,
      description:
        patched && typeof override.description === "string" && override.description !== ""
          ? override.description
          : base.description,
      // A builtin family is gated by its own switch AND the group switch.
      enabled: isBuiltin ? ownEnabled && builtinEnabled : ownEnabled,
      builtin: isBuiltin,
      packages: patched && Array.isArray(override.packages) && override.packages.length > 0
        ? override.packages.filter((entry) => typeof entry === "string")
        : [...(base.packages ?? [])],
      prefixes: patched && Array.isArray(override.prefixes) && override.prefixes.length > 0
        ? override.prefixes.filter((entry) => typeof entry === "string")
        : [...(base.prefixes ?? [])],
      tools: patched && Array.isArray(override.tools) && override.tools.length > 0
        ? override.tools.filter((entry) => typeof entry === "string")
        : [...(base.tools ?? [])],
    };
  }
  return merged;
}

/** Gateway tool name for one family id (`gatewayPrefix` + id). */
export function gatewayName(prefix, familyId) {
  return typeof prefix === "string" && prefix !== "" ? `${prefix}${familyId}` : familyId;
}

/**
 * Build the resolver that maps a tool name (plus its owner) to a family id.
 *
 * @param families - resolved family table.
 * @param ownerOf - name -> package name | `mcp:<server>` | undefined.
 * @returns `familyOf(name)` and `ownerOfName(name)`.
 */
export function createFamilyResolver(families, ownerOf) {
  /** name -> family id, memoized; undefined marks "resolved as none". */
  const memo = new Map();

  const memberOf = (name, owner) => {
    if (GATEWAY_NAMES.has(name)) return undefined;
    // Builtin families match by explicit name first: their members belong to
    // packages that also register resident tools we must not capture.
    for (const family of Object.values(families)) {
      if (family.builtin === true && (family.tools ?? []).includes(name)) return family.id;
    }
    if (owner !== undefined) {
      if (typeof owner === "string" && owner.startsWith("mcp:")) {
        const mcpFamily = families.mcp_servers;
        if (mcpFamily !== undefined && mcpFamily.packages?.length === 0
          && (mcpFamily.prefixes ?? []).some((prefix) => name.startsWith(prefix))) {
          return "mcp_servers";
        }
        if (mcpFamily !== undefined && (mcpFamily.packages ?? []).includes(owner)) return "mcp_servers";
      }
      for (const family of Object.values(families)) {
        if ((family.packages ?? []).includes(owner)) return family.id;
      }
    }
    for (const family of Object.values(families)) {
      if ((family.prefixes ?? []).some((prefix) => prefix !== "" && name.startsWith(prefix))) return family.id;
    }
    return undefined;
  };

  const familyOf = (name) => {
    if (typeof name !== "string" || name === "") return undefined;
    if (memo.has(name)) return memo.get(name);
    const family = memberOf(name, ownerOf(name));
    memo.set(name, family);
    return family;
  };

  return {
    familyOf,
    /** Family ids that currently have at least one member in `names`. */
    activeIn(names) {
      const seen = new Set();
      for (const name of names) {
        const family = familyOf(name);
        if (family !== undefined) seen.add(family);
      }
      return seen;
    },
    /** Drop memoized lookups (a family table change makes old answers stale). */
    reset() {
      memo.clear();
    },
  };
}

/**
 * Compute the frozen wire surface.
 *
 * The result is an ordered array of schema objects taken by reference from the
 * assembled list, so repeated calls that see the same input return byte-identical
 * JSON. Ordering is code-unit by name, matching what `dsh-system-prompt` does
 * before it hands tools to the provider.
 *
 * @param tools - `assembly.tools` as produced by every other listener.
 * @param options.familyOf - name -> family id | undefined.
 * @param options.families - resolved family table (for `enabled`).
 * @param options.alwaysExpose - names forced onto the wire.
 * @param options.alwaysHide - names forced off the wire.
 * @param options.unknownOwnerPolicy - "expose" | "collapse".
 * @param options.keepNames - extra names to keep (gateway tools themselves).
 * @returns the filtered, ordered schema array plus a per-family breakdown.
 */
export function buildFrozenSurface(tools, options) {
  const { familyOf, families, alwaysExpose, alwaysHide, unknownOwnerPolicy, keepNames } = options;
  const expose = new Set(alwaysExpose ?? []);
  const hide = new Set(alwaysHide ?? []);
  const keep = keepNames instanceof Set ? keepNames : new Set(keepNames ?? []);
  const collapsed = [];
  const kept = [];

  for (const schema of tools ?? []) {
    const name = schema?.name;
    if (typeof name !== "string" || name === "") continue;
    if (expose.has(name)) {
      kept.push(schema);
      continue;
    }
    if (hide.has(name)) {
      collapsed.push(name);
      continue;
    }
    if (keep.has(name) || isKeepTool(name)) {
      kept.push(schema);
      continue;
    }
    const family = familyOf(name);
    if (family === undefined) {
      // Unknown owner: exposing is the safe default ("rather save less than lose a tool").
      if (unknownOwnerPolicy === "collapse") collapsed.push(name);
      else kept.push(schema);
      continue;
    }
    const definition = families[family];
    if (definition === undefined || definition.enabled === false) {
      kept.push(schema);
      continue;
    }
    collapsed.push(name);
  }

  kept.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { tools: kept, collapsed };
}
