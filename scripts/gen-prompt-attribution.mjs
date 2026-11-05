/**
 * Generate `lib/prompt-attribution.js` — a name-to-package snapshot for prompt
 * sections and runtime contexts.
 *
 * Why a snapshot: `systemPrompt.section()` / `.context()` are called during a
 * plugin's `apply`, i.e. *before* dsh-tool-gate mounts (it is the last bundle in
 * the profile). Wrapping the service only observes registrations that happen
 * afterwards, so the already-registered names need a static table. Regenerating
 * it after installing a new plugin is the whole maintenance cost.
 *
 * Usage:
 *   node scripts/gen-prompt-attribution.mjs [<node_modules dir> ...]
 *
 * Defaults to this machine's two trees. Names built from template literals are
 * stored as prefixes so one rule covers every server.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "..", "lib", "prompt-attribution.js");

const DEFAULT_ROOTS = [
  "C:/Users/Administrator/.dsh/profiles/desktop/node_modules",
  "D:/deepseek_work/asar_x/dsh/node_modules",
];

const REGISTRATION = /systemPrompt\.(section|context)\(\{/g;
const NAME_LITERAL = /name:\s*"([^"$`]+)"/;
const NAME_TEMPLATE = /name:\s*`([^`]*)`/;
const REQUIRED = /required:\s*true/;
const ORDER = /order:\s*([^,\n}]+)/;

/**
 * Resolve `const NAME = "literal"` declarations in one file so a template such as
 * `` `tool:${toolName}` `` becomes an exact name instead of a `tool:*` wildcard.
 * Wildcards are a last resort: `tool:*` would attribute every first-party tool
 * section to whichever plugin happened to use a template first.
 *
 * Destructured config keys (`const { toolName } = config`) are resolved from the
 * schemastery default in the same file (`toolName: z.string().default("x")`).
 */
function localConstants(source) {
  const map = new Map();
  const declaration = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*"([^"\\]*)"\s*;/g;
  let match;
  while ((match = declaration.exec(source)) !== null) map.set(match[1], match[2]);
  const defaulted = /\b([A-Za-z_$][\w$]*)\s*:\s*z\.[^,;\n]*?\.default\(\s*"([^"\\]*)"\s*\)/g;
  while ((match = defaulted.exec(source)) !== null) {
    if (!map.has(match[1])) map.set(match[1], match[2]);
  }
  return map;
}

/** Expand `${ident}` in a template literal body; returns null when any is unknown. */
function expandTemplate(raw, constants) {
  let unresolved = false;
  const expanded = raw.replace(/\$\{([A-Za-z_$][\w$]*)\}/g, (_whole, ident) => {
    const value = constants.get(ident);
    if (value === undefined) {
      unresolved = true;
      return "";
    }
    return value;
  });
  return unresolved ? null : expanded;
}

/** Walk a package root, yielding every `.js` file outside nested node_modules. */
function* walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile() && entry.name.endsWith(".js")) yield full;
  }
}

/** Read `name` from the nearest package.json above `file`. */
function packageOf(file, cache) {
  let dir = path.dirname(file);
  for (let depth = 0; depth < 12; depth += 1) {
    if (cache.has(dir)) return cache.get(dir);
    const manifest = path.join(dir, "package.json");
    if (fs.existsSync(manifest)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(manifest, "utf8"));
        if (typeof parsed.name === "string") {
          cache.set(dir, parsed.name);
          return parsed.name;
        }
      } catch {
        /* keep walking */
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  cache.set(path.dirname(file), undefined);
  return undefined;
}

/** Slice from a registration keyword to the matching close paren (best effort). */
function bodyFrom(source, start) {
  let depth = 0;
  for (let index = start; index < source.length && index < start + 2000; index += 1) {
    const char = source[index];
    if (char === "(" || char === "{" || char === "[") depth += 1;
    else if (char === ")" || char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return source.slice(start, start + 600);
}

const tables = new Map();
const cache = new Map();

for (const root of process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_ROOTS) {
  if (!fs.existsSync(root)) continue;
  for (const file of walk(root)) {
    let source;
    try {
      source = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (!source.includes("systemPrompt.section(") && !source.includes("systemPrompt.context(")) continue;
    const pkg = packageOf(file, cache);
    if (pkg === undefined) continue;
    const constants = localConstants(source);
    REGISTRATION.lastIndex = 0;
    let match;
    while ((match = REGISTRATION.exec(source)) !== null) {
      const body = bodyFrom(source, match.index);
      const required = REQUIRED.test(body);
      const order = ORDER.exec(body)?.[1]?.trim();
      const literal = NAME_LITERAL.exec(body);
      const template = NAME_TEMPLATE.exec(body);
      const record = { kind: match[1], package: pkg, required, order };
      if (literal) {
        tables.set(literal[1], { ...record, name: literal[1] });
        continue;
      }
      if (template === null) continue;
      // Prefer an exact name resolved from file-local constants; a wildcard would
      // attribute every name the prefix covers to whichever plugin matched first.
      const exact = expandTemplate(template[1], constants);
      if (exact !== null && exact !== "" && !exact.includes("${")) {
        tables.set(exact, { ...record, name: exact });
        continue;
      }
      const raw = template[1];
      const cut = raw.indexOf("${");
      const prefix = cut < 0 ? raw : raw.slice(0, cut);
      // `tool:` is a shared namespace: several first-party packages name their
      // sections that way, so a wildcard would hand every unknown `tool:*` name
      // to whichever plugin matched first. Refuse it — unresolved names stay
      // injected, which is the safe default.
      if (prefix === "" || prefix === "tool:") continue;
      tables.set(`${prefix}*`, { ...record, name: `${prefix}*`, prefix: true });
    }
  }
}

const sorted = [...tables.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
const lines = sorted.map(([key, row]) => {
  const parts = [`    kind: ${JSON.stringify(row.kind)}`, `package: ${JSON.stringify(row.package)}`];
  if (row.required) parts.push("required: true");
  if (row.prefix) parts.push("prefix: true");
  return `  ${JSON.stringify(key)}: { ${parts.join(", ")} },`;
});

const output = `/**
 * GENERATED by \`scripts/gen-prompt-attribution.mjs\` — do not edit by hand.
 *
 * Prompt section / runtime context name -> the package that registered it.
 * Regenerate after installing a plugin whose prompt text should become
 * disclosable; anything absent here is simply left injected.
 *
 * A key ending in \`*\` is a prefix rule covering every name that starts with it
 * (one rule per template-literal registration, e.g. one per MCP server).
 */
export const PROMPT_ATTRIBUTION = {
${lines.join("\n")}
};

export default PROMPT_ATTRIBUTION;
`;

fs.writeFileSync(OUT, output, "utf8");
console.log(`wrote ${path.relative(process.cwd(), OUT)} with ${sorted.length} entr${sorted.length === 1 ? "y" : "ies"}`);
for (const [key, row] of sorted) console.log(`  ${key.padEnd(34)} ${row.package}${row.required ? " (required)" : ""}${row.prefix ? " (prefix)" : ""}`);
