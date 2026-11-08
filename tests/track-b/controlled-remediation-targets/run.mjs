// Local-only direct route + core contract checks; no installation or network.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const result = spawnSync(process.execPath, ['--test','--test-concurrency=1',fileURLToPath(new URL('./route.test.mjs',import.meta.url))], {stdio:'inherit'});
if(result.error)throw result.error;
if(result.status!==0)process.exit(result.status??1);
console.log('INTERNAL FIXTURE ONLY: strict route TS, frozen all12 objective checks, core payload-derived receipts; no live Naive proposal, hosted HTTP, remote LLM or attestation.');
