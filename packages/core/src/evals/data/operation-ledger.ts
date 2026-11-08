import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { reviewDigest } from './binding';
import { inspectDataSafety } from './quality';

export interface DataOperation {
  key: string;
  digest: string;
  state: 'pending' | 'complete';
  result?: unknown;
  /** An opaque authenticated operator/provider reconciliation receipt; never raw errors. */
  reconciliationReceipt?: string;
}
/** Atomic durable ownership. No expiry or automatic stealing of ambiguous effects. */
export interface DataOperationLedger {
  claim(key: string, digest: string): Promise<{ claimed: boolean; record: DataOperation }>;
  get(key: string): Promise<DataOperation | null>;
  complete(key: string, digest: string, result: unknown, reconciliationReceipt?: string): Promise<void>;
}

/** Single-host durable reference adapter. Stale locks require operator inspection, never timer reclaim. */
export function createFileDataOperationLedger(directory: string, knownSecrets: readonly string[] = []): DataOperationLedger {
  const path = (key: string) => join(directory, `${reviewDigest(key)}.json`);
  const screen = (value: unknown) => {
    if (!inspectDataSafety(value, knownSecrets).safe) throw new Error('Unsafe data operation');
  };
  async function get(key: string): Promise<DataOperation | null> {
    screen(key);
    try {
      const file = await open(path(key), 'r');
      let raw: string;
      try {
        if ((await file.stat()).size > 1_000_000) throw new Error('Oversized operation');
        raw = await file.readFile('utf8');
      } finally { await file.close(); }
      const envelope = JSON.parse(raw) as { record: DataOperation; checksum: string };
      const record = envelope.record;
      screen(record);
      if (reviewDigest(record) !== envelope.checksum || record.key !== key || !/^[a-f0-9]{64}$/.test(record.digest)
        || !['pending', 'complete'].includes(record.state) || record.state === 'complete' && record.result === undefined) throw new Error('Invalid operation');
      return record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new Error('Data operation read failed');
    }
  }
  async function locked<T>(key: string, action: () => Promise<T>): Promise<T> {
    screen(key);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const lock = `${path(key)}.lock`;
    try { await mkdir(lock, { mode: 0o700 }); } catch { throw new Error('Data operation busy or unavailable'); }
    try { return await action(); } finally { await rm(lock, { recursive: true, force: true }); }
  }
  async function write(record: DataOperation) {
    screen(record);
    const temporary = `${path(record.key)}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify({ record, checksum: reviewDigest(record) })); await file.sync(); }
      finally { await file.close(); }
      await rename(temporary, path(record.key));
      const parent = await open(directory, 'r');
      try { await parent.sync(); } finally { await parent.close(); }
    } finally { await rm(temporary, { force: true }); }
  }
  return {
    get,
    claim: (key, digest) => locked(key, async () => {
      if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid operation digest');
      const existing = await get(key);
      if (existing) {
        if (existing.digest !== digest) throw new Error('Data operation identity conflict');
        return { claimed: false, record: existing };
      }
      const record: DataOperation = { key, digest, state: 'pending' };
      await write(record);
      return { claimed: true, record };
    }),
    complete: (key, digest, result, reconciliationReceipt) => locked(key, async () => {
      const current = await get(key);
      if (!current || current.digest !== digest || result === undefined) throw new Error('Data operation identity conflict');
      if (current.state === 'complete') {
        if (reviewDigest(current.result) !== reviewDigest(result)) throw new Error('Immutable data operation conflict');
        return;
      }
      if (reconciliationReceipt !== undefined && !/^[A-Za-z0-9_-]{1,96}$/.test(reconciliationReceipt)) throw new Error('Invalid reconciliation receipt');
      await write({ ...current, state: 'complete', result, ...(reconciliationReceipt ? { reconciliationReceipt } : {}) });
    }),
  };
}
