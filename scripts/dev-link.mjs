/**
 * Make the host packages importable from this package's own directory.
 *
 * Why this exists: when this bundle is installed into a DSH profile with
 * `link:`, pnpm puts a symlink in the profile's `node_modules` but does not
 * install this package's bare imports next to its *real* path. Node resolves a
 * linked package's imports from the real path, so `@deepseek-ai/schemastery`
 * (a hard dependency) and `@deepseek-ai/dsh-tools` (needed only by the tests)
 * are not found until a junction exists here.
 *
 * Usage — point it at a directory that contains the host's @deepseek-ai scope:
 *
 *   node scripts/dev-link.mjs "C:/Program Files/DeepSeek Harness/resources/app.asar.unpacked/dsh/node_modules/@deepseek-ai"
 *   node scripts/dev-link.mjs "C:/Users/<you>/.dsh/profiles/desktop/node_modules/@deepseek-ai"
 *
 * Every missing package in that scope is junctioned into
 * `node_modules/@deepseek-ai/<name>`; existing entries are left alone.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCOPE = path.join(PACKAGE_ROOT, "node_modules", "@deepseek-ai");

/**
 * Packages that must resolve from here: one hard dependency at runtime
 * (`schemastery`), and the host packages this package imports — the host routes
 * those in memory at runtime, but `node test/*.mjs` needs real files.
 */
const WANTED = ["schemastery", "dsh-tools", "dsh-session", "dsh-system-prompt"];

const source = process.argv[2];
if (!source) {
  console.error("usage: node scripts/dev-link.mjs <path to a host @deepseek-ai scope>");
  process.exit(2);
}
if (!fs.existsSync(source)) {
  console.error(`not found: ${source}`);
  process.exit(2);
}

fs.mkdirSync(SCOPE, { recursive: true });

let linked = 0;
for (const name of WANTED) {
  const from = path.join(source, name);
  const to = path.join(SCOPE, name);
  if (!fs.existsSync(from)) {
    console.warn(`skip ${name}: not present in ${source}`);
    continue;
  }
  if (fs.existsSync(to)) {
    console.log(`ok   ${name}: already resolvable`);
    continue;
  }
  fs.symlinkSync(from, to, "junction");
  console.log(`link ${name} -> ${from}`);
  linked += 1;
}
console.log(`done, ${linked} new link(s)`);
