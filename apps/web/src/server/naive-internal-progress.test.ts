import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readInternalProgress } from './naive-internal-progress';

const jobId = '11111111-1111-4111-8111-111111111111';
const customerId = '22222222-2222-4222-8222-222222222222';
const rowId = '33333333-3333-4333-8333-333333333333';
const at = '2026-01-01T00:00:00.000Z';
let db: PGlite;
const read = () => readInternalProgress(db, { jobId, customerId });
beforeEach(async () => {
  db = new PGlite();
  await db.exec(`CREATE TABLE jobs(id uuid PRIMARY KEY,customer_id uuid,state text,updated_at timestamptz);
    CREATE TABLE progress_events(id text,job_id uuid,milestone text,created_at timestamptz);
    CREATE TABLE findings(id text,job_id uuid,data jsonb,created_at timestamptz);
    CREATE TABLE costs(id text,job_id uuid,source text,micro_usd bigint,created_at timestamptz);`);
  await db.query('INSERT INTO jobs VALUES($1,$2,$3,$4)', [jobId, customerId, 'running', at]);
});
afterEach(async () => { await db.close(); });
describe('persisted internal progress projection', () => {
  it('rechecks exact ownership and rejects missing jobs and invalid input', async () => {
    await expect(readInternalProgress(db, { jobId, customerId: rowId })).rejects.toThrow('internal_progress_unavailable');
    await expect(readInternalProgress(db, { jobId: rowId, customerId })).rejects.toThrow('internal_progress_unavailable');
    await expect(readInternalProgress(db, { jobId: 'https://private', customerId })).rejects.toThrow('internal_progress_unavailable');
  });
  it('projects only persisted safe facts and row evidence references', async () => {
    await db.query('INSERT INTO findings VALUES($1,$2,$3,$4)', [rowId, jobId, JSON.stringify({status:'confirmed', severity:'high', evidence:[{excerpt:'SECRET',location:'https://private'}], title:'SECRET'}), at]);
    await db.query('INSERT INTO progress_events VALUES($1,$2,$3,$4)', [rowId, jobId, 'custom secret milestone', '2026-01-02T00:00:00Z']);
    await db.query('INSERT INTO costs VALUES($1,$2,$3,$4,$5)', [rowId, jobId, 'ai_gateway', '42', at]);
    const result = await read();
    expect(result.observedAt).toBe('2026-01-02T00:00:00.000Z');
    expect(result.findings).toEqual([{id:rowId,status:'confirmed',severity:'high',evidenceRefs:[`finding:${rowId}`]}]);
    expect(result.costs).toHaveLength(1); expect(result.costs[0]?.microUsd).toBe(42);
    expect(result.milestones[0]?.milestone).toBe('other');
    expect(result.unknownCosts).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/SECRET|https:|custom secret/);
  });
  it('does not relabel proxy costs or include other job costs', async () => {
    await db.query('INSERT INTO costs VALUES($1,$2,$3,$4,$5)', [rowId,jobId,'naive_proxy',9,at]);
    await db.query('INSERT INTO costs VALUES($1,$2,$3,$4,$5)', [rowId,rowId,'naive',99,at]);
    expect((await read()).costs).toEqual([]);
  });
  it.each(['progress_events','findings','costs'])('rejects overflowing %s inventories', async table => {
    const limit = table === 'costs' ? 1000 : 200;
    const fields = table === 'costs' ? "'naive', 1" : table === 'findings' ? `' {"status":"confirmed","severity":"low","evidence":[{}]}'::jsonb` : "'running'";
    await db.query(`INSERT INTO ${table} SELECT $1,$2,${fields},$3::timestamptz FROM generate_series(1,${limit + 1})`, [rowId,jobId,at]);
    await expect(read()).rejects.toThrow('internal_progress_unavailable');
  });
  it('rejects unsafe row IDs, unsupported status, and invalid findings', async () => {
    await db.query('INSERT INTO progress_events VALUES($1,$2,$3,$4)', ['https://private',jobId,'running',at]);
    await expect(read()).rejects.toThrow('internal_progress_unavailable');
    await db.exec('DELETE FROM progress_events');
    await db.query('UPDATE jobs SET state=$1', ['completed']);
    await expect(read()).rejects.toThrow('internal_progress_unavailable');
    await db.query('UPDATE jobs SET state=$1', ['running']);
    await db.query('INSERT INTO findings VALUES($1,$2,$3,$4)', [rowId,jobId,'{"status":"confirmed","severity":"high","evidence":[]}',at]);
    await expect(read()).rejects.toThrow('internal_progress_unavailable');
  });
  it('rejects unsafe individual and summed cost integers', async () => {
    await db.query('INSERT INTO costs VALUES($1,$2,$3,$4,$5)', [rowId,jobId,'naive','9007199254740992',at]);
    await expect(read()).rejects.toThrow('internal_progress_unavailable');
    await db.query('UPDATE costs SET micro_usd=$1', ['9007199254740991']);
    await db.query('INSERT INTO costs VALUES($1,$2,$3,$4,$5)', [rowId,jobId,'ai_gateway',1,at]);
    await expect(read()).rejects.toThrow('internal_progress_unavailable');
  });
});
