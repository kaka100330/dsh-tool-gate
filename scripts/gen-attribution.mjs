/**
 * Regenerate lib/builtin-attribution.js from data/attribution.json.
 *
 * The map is only a last-resort fallback: live attribution (the `register`
 * wrapper in owner.js) wins whenever it has an answer, and this table covers
 * tools that were already in the registry before this plugin mounted.
 *
 * data/attribution.json maps a tool name to `[tier, packageName]`, where tier is
 * "core" or "third", and packageName is sometimes a *bare* directory name
 * (`dsh-tool-fs`) rather than the package's real name (`@deepseek-ai/dsh-tool-fs`).
 * Left as-is, a tool appears under two spellings depending on which layer
 * answered — which is how the settings page ended up listing `dsh-tool-fs` and
 * `@deepseek-ai/dsh-tool-fs` as two different plugins.
 *
 * So every bare name is resolved against the installed trees: if
 * `<host>/@deepseek-ai/<bare>/package.json` exists, its own `name` field wins.
 *
 * Usage:
 *   node scripts/gen-attribution.mjs [hostNodeModulesDir ...]
 * Defaults to the asar checkout and the desktop profile's node_modules.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DEFAULT_HOSTS = [
  "D:/deepseek_work/asar_x/dsh/node_modules",
  "C:/Users/Administrator/.dsh/profiles/desktop/node_modules",
];

const hosts = process.argv.length > 2 ? process.argv.slice(2) : DEFAULT_HOSTS;

/** Read one package.json, or undefined. */
function readPackageJson(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Resolve a directory-style package name to its declared package name.
 *
 * Several layouts are tried because a bundle can live under `@scope/name`, under
 * its bare name, or under a nested `node_modules`. A name that already carries a
 * scope is returned untouched.
 */
function resolvePackageName(raw) {
  if (typeof raw !== "string" || raw === "") return raw;
  if (raw.startsWith("@")) return raw;
  for (const host of hosts) {
    for (const candidate of [
      path.join(host, "@deepseek-ai", raw),
      path.join(host, raw),
      path.join(host, raw, "node_modules", raw),
    ]) {
      const pkg = readPackageJson(candidate);
      if (typeof pkg?.name === "string" && pkg.name !== "") return pkg.name;
    }
  }
  return raw;
}

const source = JSON.parse(
  fs.readFileSync(path.join(PACKAGE_ROOT, "data", "attribution.json"), "utf8"),
);

const resolved = new Map();
/** Keep only entries that name a package, and normalise every package name. */
const entries = Object.entries(source)
  .filter(([, value]) => Array.isArray(value) && typeof value[1] === "string" && value[1] !== "")
  .map(([name, value]) => {
    const raw = value[1];
    let pkg = resolved.get(raw);
    if (pkg === undefined) {
      pkg = resolvePackageName(raw);
      resolved.set(raw, pkg);
    }
    return [name, pkg];
  })
  .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

const lines = [];
lines.push("/**");
lines.push(" * Generated attribution: tool name -> owning package name.");
lines.push(" *");
lines.push(" * This is the last-resort layer in `owner.js`. Live attribution — the instance");
lines.push(" * `register` wrapper fed by `internal/get` — always wins when it has an answer;");
lines.push(" * this table only covers tools that were already registered before this plugin");
lines.push(" * mounted, where no registration call is left to observe.");
lines.push(" *");
lines.push(" * Package names are normalised to the names the packages declare for themselves,");
lines.push(" * so this table and live attribution cannot spell the same plugin two ways.");
lines.push(" *");
lines.push(" * Regenerate with `node scripts/gen-attribution.mjs` after installing or removing");
lines.push(" * a plugin that ships tools. Do not edit by hand.");
lines.push(" */");
lines.push("export const BUILTIN_ATTRIBUTION = {");
for (const [name, pkg] of entries) {
  lines.push(`  ${JSON.stringify(name)}: ${JSON.stringify(pkg)},`);
}
lines.push("};");
lines.push("");
lines.push("export default BUILTIN_ATTRIBUTION;");
lines.push("");

const out = path.join(PACKAGE_ROOT, "lib", "builtin-attribution.js");
fs.writeFileSync(out, lines.join("\n"), "utf8");
const renamed = [...resolved].filter(([raw, pkg]) => raw !== pkg);
console.log(`wrote ${out} with ${entries.length} entries`);
console.log(`normalised ${renamed.length} package name(s):`);
for (const [raw, pkg] of renamed) console.log(`  ${raw} -> ${pkg}`);
