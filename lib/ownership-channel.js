/**
 * Who registered this — read from the context the call arrived on.
 *
 * Both attribution problems in this plugin have the same shape. A service method
 * runs, and we need to know *which package asked for it*, without guessing:
 *
 *  - `tools.register(definition)` — which plugin registered this tool?
 *  - `systemPrompt.section(entry)` — which plugin injected this prompt text?
 *
 * The old answers were a stack walk (nearest `package.json` above the caller's
 * frame) and `ctx.fiber.name` (always this plugin's own fiber). The stack walk
 * is slow and wrong whenever the registry calls back through framework code; the
 * fiber name is simply never the caller.
 *
 * There is an exact answer. The Loader gives every configured plugin its own
 * context, tagged with the entry that owns it:
 *
 *     this.ctx = loader.ctx.extend({ [Entry.key]: this })   // cordis-plugin-loader
 *
 * `Entry.key` is `Symbol.for("cordis.entry")` and its `options.name` is the
 * package name from `cordis.patch.yml`. Cordis hands a service method a
 * *traceable proxy* whose `ctx` property is the **calling** context — so inside
 * a wrapped method, `this.ctx[ENTRY].options.name` is the registrant. Verified
 * against cordis 4.0.5: for a real plugin fiber the value is exact, and a
 * registration made from the root context (the harness itself) yields
 * `undefined`.
 *
 * The symbol is spelled literally rather than imported: this plugin must not
 * take a dependency on the Loader, and `Symbol.for` is cross-realm stable.
 */

/** The Loader's per-entry context tag (`cordis-plugin-loader` `Entry.key`). */
export const ENTRY_KEY = Symbol.for("cordis.entry");

/** How far up the prototype chain to look before giving up. Entry contexts nest. */
const MAX_DEPTH = 12;

/** Read one candidate's package name, tolerating a throwing getter. */
function nameOf(context) {
  try {
    const name = context?.[ENTRY_KEY]?.options?.name;
    return typeof name === "string" && name !== "" ? name : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The package that owns a context, or `undefined` when it is not a plugin.
 *
 * A plugin's context nests (`entry.ctx.extend(...)`, then the plugin's own
 * `ctx.extend(...)`), and each level inherits the entry tag through the
 * prototype chain. Walking up is therefore only a fallback for the shallow
 * case; the first hit is the answer.
 *
 * @param context - a Cordis context, usually `this.ctx` inside a wrapped method.
 * @returns the owning package name, or `undefined` for root/framework code.
 */
export function packageOfContext(context) {
  if (context === null || context === undefined) return undefined;
  let cursor = context;
  for (let depth = 0; depth < MAX_DEPTH && cursor !== null && cursor !== undefined; depth += 1) {
    const name = nameOf(cursor);
    if (name !== undefined) return name;
    try {
      cursor = Object.getPrototypeOf(cursor);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * The package that owns a service method call in progress.
 *
 * Cordis makes `this` a traceable proxy for services; its `ctx` property is the
 * caller's context. A plain (non-service) object has no `ctx`, and the root
 * context has no entry tag — both answer `undefined`, which every caller here
 * treats as "leave it alone".
 *
 * @param receiver - the `this` of the method being wrapped.
 * @returns the calling package name, or `undefined`.
 */
export function callerPackageOf(receiver) {
  if (receiver === null || typeof receiver !== "object") return undefined;
  let context;
  try {
    context = receiver.ctx;
  } catch {
    return undefined;
  }
  return packageOfContext(context);
}

/**
 * Whether a package name belongs to the harness itself rather than a profile
 * plugin. One definition, used by family discovery, the settings rows and the
 * MCP identity check — three places used to spell out their own prefix list and
 * two of them disagreed.
 *
 * @param pkg - a package name.
 * @returns whether it ships with the harness.
 */
export const HARNESS_PACKAGE_PREFIXES = ["@deepseek-ai/", "@dsh-ops/"];

export function isHarnessPackage(pkg) {
  return typeof pkg === "string" && HARNESS_PACKAGE_PREFIXES.some((prefix) => pkg.startsWith(prefix));
}
