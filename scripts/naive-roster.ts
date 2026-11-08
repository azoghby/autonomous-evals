/** Offline roster handoff only. Never reads provider keys or role credential files. */
import { constants } from 'node:fs';
import { open, mkdir, lstat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileRosterStage } from './naive-roster-config';
import { buildRosterApplicationHandoff } from './naive-roster-handoff';
import { writePrivateProvisionPlan } from '../packages/core/src/agents/provision-file-journal';

const fail = (): never => { throw Error('Roster configuration unavailable'); };
const MAX_BYTES = 2_000_000;
/** Bound the actual read, reject symlinks and shared files, and never put input into errors. */
export async function readPrivateRosterJson(path: string): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) return fail();
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_BYTES) return fail();
    return JSON.parse(buffer.subarray(0, offset).toString('utf8'));
  } finally { await file.close(); }
}
function destination(path: string): string {
  if (!path || /^\.env(?:\.|$)/i.test(basename(path))) return fail();
  return resolve(path);
}
export async function runRosterCli(args: readonly string[]) {
  const [mode, specPath, output, ...receiptPaths] = args;
  if (!specPath || !output || (mode !== '--next' && mode !== '--handoff') || receiptPaths.length > 5 || mode === '--next' && receiptPaths.length > 4 || mode === '--handoff' && receiptPaths.length !== 5) return fail();
  const spec = await readPrivateRosterJson(specPath);
  const receipts: unknown[] = [];
  for (const path of receiptPaths) receipts.push(await readPrivateRosterJson(path));
  // Complete all semantic validation before making any output path.
  if (mode === '--handoff') {
    const handoff = buildRosterApplicationHandoff(spec, receipts);
    await writePrivateProvisionPlan(destination(output), handoff);
    return { mode: 'offline_application_handoff', saved: true, agents: 15, deployments: 5, applyReady: false };
  }
  const compiled = compileRosterStage(spec, receipts);
  const dir = destination(output);
  await mkdir(dir, { mode: 0o700 }); // Exclusive directory: never overwrite another run's pair.
  const stat = await lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) return fail();
  await writePrivateProvisionPlan(resolve(dir, 'options.json'), compiled.options);
  await writePrivateProvisionPlan(resolve(dir, 'plan.json'), compiled.plan);
  return { mode: 'offline_stage_plan', stage: compiled.plan.stage, operations: compiled.plan.operations.length, saved: true, applyReady: false };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runRosterCli(process.argv.slice(2)).then(summary => process.stdout.write(JSON.stringify(summary) + '\n')).catch(() => {
    process.stderr.write('Roster handoff blocked. Check private configuration and ordered receipt evidence; use a fresh output path after a partial write.\n');
    process.exitCode = 1;
  });
}
