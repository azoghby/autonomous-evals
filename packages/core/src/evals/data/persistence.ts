import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { EvaluationDataStore, EvaluationDataTask } from "./acquisition";
import { inspectDataSafety } from "./quality";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const MAX_BYTES = 4 * 1024 * 1024;

/** Persistent single-host adapter; use a transactional database adapter on Vercel. */
export function createFileEvaluationDataStore(directory: string, knownSecrets: readonly string[] = []): EvaluationDataStore {
  const path = (id: string) => join(directory, `${digest(id)}.json`);
  function validate(record: EvaluationDataTask, taskId: string): void {
    if (!record || record.taskId !== taskId || record.spec?.taskId !== taskId ||
        !Number.isSafeInteger(record.revision) || record.revision < 0 ||
        !/^[a-f0-9]{64}$/.test(record.requestHash) || !Array.isArray(record.decisions) ||
        !Array.isArray(record.cases) || !Array.isArray(record.sources) ||
        !inspectDataSafety(record, knownSecrets).safe) throw new Error("Invalid evaluation-data record");
  }
  async function get(taskId: string): Promise<EvaluationDataTask | null> {
    try {
      if ((await stat(path(taskId))).size > MAX_BYTES) throw new Error("Oversized record");
      const envelope = JSON.parse(await readFile(path(taskId), "utf8")) as { payload: string; checksum: string };
      if (typeof envelope.payload !== "string" || digest(envelope.payload) !== envelope.checksum) throw new Error("Invalid checksum");
      const record = JSON.parse(envelope.payload) as EvaluationDataTask;
      validate(record, taskId);
      return record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new Error("Evaluation-data storage read failed");
    }
  }
  async function locked<T>(taskId: string, action: () => Promise<T>): Promise<T> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const lock = `${path(taskId)}.lock`;
    try { await mkdir(lock, { mode: 0o700 }); }
    catch { throw new Error("Evaluation-data storage busy or unavailable"); }
    try { return await action(); } finally { await rm(lock, { recursive: true, force: true }); }
  }
  async function write(record: EvaluationDataTask): Promise<void> {
    validate(record, record.taskId);
    const payload = JSON.stringify(record);
    const body = JSON.stringify({ payload, checksum: digest(payload) });
    if (Buffer.byteLength(body) > MAX_BYTES) throw new Error("Evaluation-data storage capacity exceeded");
    const temporary = `${path(record.taskId)}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(body); await file.sync(); } finally { await file.close(); }
      await rename(temporary, path(record.taskId));
      const parent = await open(directory, "r");
      try { await parent.sync(); } finally { await parent.close(); }
    } finally { await rm(temporary, { force: true }); }
  }
  return {
    get,
    insertIfAbsent: (record) => locked(record.taskId, async () => {
      const existing = await get(record.taskId);
      if (existing) return { inserted: false, record: existing };
      if (record.revision !== 0) throw new Error("Initial evaluation-data revision must be zero");
      await write(record);
      return { inserted: true, record: structuredClone(record) };
    }),
    compareAndSet: (taskId, revision, next) => locked(taskId, async () => {
      const current = await get(taskId);
      if (!current || current.revision !== revision) return null;
      validate(next, taskId);
      if (next.revision !== revision + 1 || next.requestHash !== current.requestHash ||
          JSON.stringify(next.spec) !== JSON.stringify(current.spec)) throw new Error("Invalid evaluation-data transition");
      await write(next);
      return structuredClone(next);
    }),
  };
}
