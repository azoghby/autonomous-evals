/**
 * Runs the EvalServices conformance harness against Track B's real services.
 * Usage: npx tsx scripts/conformance.ts [--skip-branching] [--skip-suite]
 * Exits non-zero on any failed check, or if the real module is missing.
 */
import { runConformance, summarize } from "../packages/core/src/contracts/conformance";
import type { EvalServices } from "../packages/core/src/contracts/services";

async function main() {
  const modPath = "@ae/core/evals/index";
  let services: EvalServices | undefined;
  try {
    const mod = (await import(modPath)) as { evalServices?: EvalServices };
    services = mod.evalServices;
    if (!services) { console.error(`${modPath} loaded but does not export \`evalServices\`.`); process.exit(2); }
  } catch (e) {
    const err = e as { code?: string; message?: string };
    if (err.code === "ERR_MODULE_NOT_FOUND" || err.code === "MODULE_NOT_FOUND" || /Cannot find (module|package)/.test(err.message ?? "")) {
      console.error(`Track B module not found: packages/core/src/evals/index.ts (exporting \`evalServices\`). Nothing to check yet.\n${err.message}`);
      process.exit(2);
    }
    console.error("Failed to load real services:", e);
    process.exit(2);
  }
  const args = process.argv.slice(2);
  const checks = await runConformance(services, { skipBranching: args.includes("--skip-branching"), skipSuite: args.includes("--skip-suite") });
  const icon = { pass: "PASS", fail: "FAIL", skip: "SKIP" } as const;
  const w = Math.max(...checks.map((c) => `${c.group}: ${c.name}`.length));
  for (const c of checks) console.log(`${icon[c.status]}  ${`${c.group}: ${c.name}`.padEnd(w)}  ${c.status === "pass" ? "" : c.message}`);
  const s = summarize(checks);
  console.log(`\n${s.passed} passed, ${s.failed} failed, ${s.skipped} skipped`);
  process.exit(s.failed > 0 ? 1 : 0);
}
main();
