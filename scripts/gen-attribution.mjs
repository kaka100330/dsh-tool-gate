/**
 * Regenerate lib/builtin-attribution.js from data/attribution.json.
 *
 * The map is only a last-resort fallback: live attribution (the `register`
 * wrapper in owner.js) wins whenever it has an answer, and this table covers
 * tools that were already in the registry before this plugin mounted.
 *
 * data/attribution.json maps a tool name to `[tier, packageName]`, where tier is
 * "core" or "third". Only entries naming a package are kept.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const source = JSON.parse(
  fs.readFileSync(path.join(PACKAGE_ROOT, "data", "attribution.json"), "utf8"),
);

/** Keep only entries that name a package, and drop core tools (they are kept anyway). */
const entries = Object.entries(source)
  .filter(([, value]) => Array.isArray(value) && typeof value[1] === "string" && value[1] !== "")
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
lines.push(" * Regenerate with `node scripts/gen-attribution.mjs` after installing or removing");
lines.push(" * a plugin that ships tools. Do not edit by hand.");
lines.push(" */");
lines.push("export const BUILTIN_ATTRIBUTION = {");
for (const [name, value] of entries) {
  lines.push(`  ${JSON.stringify(name)}: ${JSON.stringify(value[1])},`);
}
lines.push("};");
lines.push("");
lines.push("export default BUILTIN_ATTRIBUTION;");
lines.push("");

const out = path.join(PACKAGE_ROOT, "lib", "builtin-attribution.js");
fs.writeFileSync(out, lines.join("\n"), "utf8");
console.log(`wrote ${out} with ${entries.length} entries`);
