/**
 * Run every suite in one process-free pass.
 *
 * Each file is its own Node process on purpose: they install process-wide state
 * (`DSH_PROFILE_DIR`, the scan cache, fixture packages) and must not share it.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const SUITES = ["run.mjs", "e2e.mjs", "provider-owned.mjs", "client.mjs"];

let failed = 0;
for (const suite of SUITES) {
  process.stdout.write(`${suite.padEnd(18)} `);
  const outcome = spawnSync(process.execPath, [path.join(HERE, suite)], { encoding: "utf8" });
  if (outcome.status === 0) {
    const last = outcome.stdout.trim().split("\n").filter(Boolean).pop() ?? "ok";
    console.log(last);
  } else {
    failed += 1;
    console.log("FAILED");
    console.log(outcome.stdout);
    console.log(outcome.stderr);
  }
}
if (failed > 0) {
  console.error(`\n${failed} suite(s) failed`);
  process.exit(1);
}
console.log("\nALL SUITES PASSED");
