/**
 * Cosmetic label for auto-derived families — derived from the package name.
 *
 * There is no table here any more, and that is the point. The previous version
 * kept nine hand-written rows that *translated* names (`dsh-free-search` →
 * `搜索`, `@vectorize-io/hindsight-coding-agents` → `记忆`) and shortened seven
 * gateway names (`session_query` → `session`). Both were wrong in a way that only
 * showed up on a real profile:
 *
 *  - a translated name is not the plugin's name. `Hindsight` is a product; `记忆`
 *    is a capability — and the moment the word is wrong, nothing in the host can
 *    correct it, because the table outranked every other source;
 *  - a shortened gateway name puts two families in one namespace (`session_query`
 *    and any other `session…`) and makes the roster disagree with the page.
 *
 * The rule now: **the label is the package name, capitalised**. `dsh-`/`@scope`
 * prefixes are dropped, words are title-cased, and known acronyms stay upper-case
 * so `dsh-tool-fs` reads `FS` rather than `Fs`. The gateway name is not derived
 * here at all: `gatewayName()` in `families.js` returns the family id unless the
 * user configured a `gateway:` override.
 *
 * The cost is spelled out in the release notes and is intentional: `GitHub`
 * becomes `Github` and `Blender` becomes `Blender Plugin`, because that is what
 * the package is called. A user who wants the brand capitalisation back writes
 * `families.github.label: GitHub` — the override still outranks this function.
 *
 * Descriptions are not written here either. They come from the host
 * (`lib/plugin-meta.js` reads the same `pluginPackages` service the settings page
 * uses), so a hand-written sentence cannot drift away from the package.
 *
 * Presentation only. Membership always comes from the registry, so deleting this
 * module would cost nothing but prettier names, and no label can make a tool
 * belong to a family or stop one from belonging.
 */

/** Package-name prefixes that carry no meaning to a reader. Longest first. */
const PREFIXES = ["dsh-tool-", "dsh-plugin-", "dsh-", "plugin-"];

/** Words spelled as acronyms rather than title-cased (`fs` → `Fs`). */
const ACRONYMS = new Set(["fs", "mcp", "api", "cli", "ui", "http", "url", "json", "ide"]);

/**
 * Derive the display label from a package name or a family id.
 *
 * `@vectorize-io/hindsight-coding-agents` → `Hindsight Coding Agents`,
 * `@deepseek-ai/dsh-tool-fs` → `FS`, `dsh-blender-plugin` → `Blender Plugin`,
 * `acme_widgets` → `Acme Widgets`.
 *
 * @param pkg - package name, or a family id when there is no package.
 * @returns the derived label; the input unchanged when nothing can be derived.
 */
export function rawLabelOf(pkg) {
  let name = String(pkg ?? "");
  const slash = name.lastIndexOf("/");
  if (slash >= 0) name = name.slice(slash + 1);
  for (const prefix of PREFIXES) {
    if (name.startsWith(prefix) && name.length > prefix.length) {
      name = name.slice(prefix.length);
      break;
    }
  }
  const words = name.split(/[-_.\s]+/).filter((word) => word !== "");
  if (words.length === 0) return String(pkg ?? "");
  return words
    .map((word) => (ACRONYMS.has(word.toLowerCase())
      ? word.toUpperCase()
      : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(" ");
}

/**
 * Presentation hint for one family.
 *
 * Only the label is answered here. Descriptions are never written in this file:
 * the host is the only description source (`lib/plugin-meta.js`), and a family it
 * cannot describe carries `""` and says so — an invented sentence is what let
 * `hindsight` read as the capability word `记忆` in the first place.
 *
 * @param id - derived family id, used when there is no package.
 * @param pkg - the owning package, when there is exactly one.
 * @returns `{ label }`.
 */
export function familyLabelHints(id, pkg) {
  return { label: rawLabelOf(typeof pkg === "string" && pkg !== "" ? pkg : id) };
}

export default { familyLabelHints, rawLabelOf };
