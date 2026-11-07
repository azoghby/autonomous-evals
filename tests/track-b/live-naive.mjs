// A bounded SDK diagnostic, not the production persistence/budget adapter.
// Run with installed @usenaive-sdk/managed-agents resolvable from this file.
import { open, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

const [action, recordPath] = process.argv.slice(2);
if (!['create', 'check'].includes(action) || !recordPath) {
  console.error('Usage: node live-naive.mjs create|check /absolute/private/record.json');
  process.exit(2);
}
const apiKey = process.env.NAIVE_API_KEY;
if (!apiKey) {
  console.error('NAIVE_API_KEY is required; no request was made.');
  process.exit(2);
}
const { createClient } = await import('@usenaive-sdk/managed-agents');
const client = createClient({
  apiKey,
  fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(30_000) }),
});
const path = resolve(recordPath);
const persist = async (record) => {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, path);
};
let record;
try {
  if (action === 'create') {
    const role = process.env.NAIVE_SMOKE_ROLE;
    const agentId = process.env.NAIVE_AGENT_ID;
    if (!agentId || !['commercial', 'engineer', 'investigator', 'operator'].includes(role)) {
      throw new Error('Set NAIVE_AGENT_ID and NAIVE_SMOKE_ROLE to an existing configured agent.');
    }
    record = { kind: 'internal_sdk_smoke', role, agentId, key: randomUUID(), phase: 'creating', createdAt: new Date().toISOString(), capMicroUsd: 100_000 };
    // Exclusive intent file prevents accidental repeat creation with this record.
    const file = await open(path, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(record, null, 2) + '\n'); await file.sync(); }
    finally { await file.close(); }
    const session = await client.sessions.create({
      agent_id: agentId,
      message: 'This is an internal SDK connectivity smoke test, not customer work. Do not call tools or send messages. Return the structured object {"ok":true}.',
      budget_micro_usd: record.capMicroUsd,
      output_schema: { type: 'object', properties: { ok: { type: 'boolean', const: true } }, required: ['ok'], additionalProperties: false },
      structured_output_required: true,
      metadata: { purpose: 'track-b-sdk-smoke', role },
    }, { idempotencyKey: record.key });
    record.sessionId = session.id;
    record.agentVersion = session.agent_version;
    record.phase = 'created';
    await persist(record);
    console.log(JSON.stringify({ sessionId: record.sessionId, phase: record.phase, next: 'Run check with the same record path; never create again to poll.' }));
  } else {
    record = JSON.parse(await readFile(path, 'utf8'));
    if (record.kind !== 'internal_sdk_smoke' || !record.sessionId) {
      throw new Error('No persisted session ID. Reconcile the create attempt; do not recreate it.');
    }
    const session = await client.sessions.get(record.sessionId);
    const output = session.structured_output;
    const valid = output !== null && output.ok === true && Object.keys(output).length === 1;
    const cleanStop = session.status === 'completed' || (session.status === 'idle' && session.stop_reason === 'end_turn');
    record.phase = cleanStop && valid ? 'passed' : 'not_passed';
    record.status = session.status;
    record.stopReason = session.stop_reason;
    record.consumedMicroUsd = session.consumed_micro_usd;
    record.checkedAt = new Date().toISOString();
    await persist(record);
    console.log(JSON.stringify({ role: record.role, sessionId: record.sessionId, phase: record.phase, status: record.status, stopReason: record.stopReason, consumedMicroUsd: record.consumedMicroUsd }));
    if (record.phase !== 'passed') process.exitCode = 1;
  }
} catch (error) {
  // Provider bodies/error messages can contain sensitive data: don't print them.
  console.error(JSON.stringify({ failed: true, action, errorType: error?.name ?? 'Error', guidance: action === 'create' ? 'Inspect the private intent record. A creation timeout is ambiguous; reconcile before retrying.' : 'Check configuration and the private record; no new session was created.' }));
  process.exitCode = 1;
}
