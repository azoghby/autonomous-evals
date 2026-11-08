import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { expect, it } from 'vitest';
import { createPostgresConversationPort } from '../packages/core/src/reporting/chat/postgres-conversations';

it('separate transactional migration and conversation SQL preserve caller+job scope and replay', async () => {
  const db = new PGlite();
  try {
    await db.exec(readFileSync(new URL('./001-private-conversations.sql', import.meta.url), 'utf8'));
    const port = createPostgresConversationPort({query: (sql, params) => db.query(sql, params),
      transaction: run => db.transaction(tx => run({query: (sql, params) => tx.query(sql, params)}))});
    const scope = {subjectId: 'alice', jobId: 'job-1'};
    const input = {messageId: 'one', inputDigest: 'a'.repeat(64), reply: {asOf: '2026-11-07T00:00:00Z', topic: 'progress' as const,
      text: 'Persisted state: running.', evidenceRefs: ['opaque'], unknowns: ['ETA unknown.']}};
    const first = await port.append(scope, input);
    expect(await port.append(scope, {...input, inputDigest: 'b'.repeat(64)})).toEqual(first);
    expect(await port.get({subjectId: 'bob', jobId: 'job-1'}, 'one')).toBeNull();
    expect(await port.list({subjectId: 'alice', jobId: 'job-2'}, {afterSequence: 0, limit: 20})).toEqual([]);
    expect(await port.list(scope, {afterSequence: 0, limit: 1})).toEqual([first]);
    expect(await port.list(scope, {afterSequence: 1, limit: 1})).toEqual([]);
  } finally { await db.close(); }
});
