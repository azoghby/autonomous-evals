/** Private, append-only provisioning receipts. Torn writes fence recovery; never erase them to retry. */
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { ProvisionIntent, ProvisionJournal, ProvisionReceipt } from "./naive-provisioning";

const fail = (): never => { throw new Error("Provision journal unavailable; reconcile local state"); };
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";
const keyPattern = /^naive-provision:(skill|outcome|agent|vault|credential|deployment):[a-z][a-z0-9_-]{0,79}$/;
const fingerprintPattern = /^[a-f0-9]{64}$/;
function receipt(value: unknown): value is ProvisionReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  return Object.keys(r).every(k => k === "id" || k === "version") && typeof r.id === "string" && /^[a-z]+_[a-zA-Z0-9]+$/.test(r.id) &&
    (r.version === undefined || typeof r.version === "number" && Number.isSafeInteger(r.version) && r.version > 0);
}
function intent(value: unknown, key: string): ProvisionIntent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(k => !["key", "fingerprint", "state", "receipt"].includes(k)) || v.key !== key || typeof v.fingerprint !== "string" || !fingerprintPattern.test(v.fingerprint) ||
    (v.state !== "pending" && v.state !== "complete") || (v.state === "complete" ? !receipt(v.receipt) : v.receipt !== undefined)) return fail();
  return structuredClone(v) as unknown as ProvisionIntent;
}
const sameReceipt = (a: ProvisionReceipt, b: ProvisionReceipt) => a.id === b.id && a.version === b.version;

/** readOnly mode never creates a directory or a file, including when the journal is absent. */
export function createProvisionFileJournal(directory: string, options: { readOnly?: boolean } = {}): ProvisionJournal {
  const dir = resolve(directory);
  const filename = (key: string, completed = false) => {
    if (!keyPattern.test(key)) return fail();
    return join(dir, key.replaceAll(":", "_") + (completed ? `.complete.json` : `.json`));
  };
  async function checkDirectory(create = false): Promise<boolean> {
    if (create) {
      if (options.readOnly) return fail();
      const firstCreated = await mkdir(dir, { recursive: true, mode: 0o700 });
      if (firstCreated) {
        // Persist each newly created directory entry before any provider mutation.
        // Fsyncing only the leaf does not persist its entry in its parent.
        const stop = dirname(firstCreated);
        for (let current = dir; ; current = dirname(current)) {
          const handle = await open(await realpath(current), constants.O_RDONLY | constants.O_NOFOLLOW);
          try { await handle.sync(); } finally { await handle.close(); }
          if (current === stop) break;
        }
      }
    }
    try {
      const s = await lstat(dir);
      if (!s.isDirectory() || s.isSymbolicLink() || (s.mode & 0o077) !== 0 || (process.getuid && s.uid !== process.getuid())) return fail();
      return true;
    } catch (error) { if (!create && missing(error)) return false; throw error; }
  }
  async function load(key: string, completed = false): Promise<ProvisionIntent | undefined> {
    let f;
    try { f = await open(filename(key, completed), constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if (missing(error)) return undefined; throw error; }
    try {
      const s = await f.stat();
      if (!s.isFile() || s.size > 16_384 || (s.mode & 0o077) !== 0 || (process.getuid && s.uid !== process.getuid())) return fail();
      return intent(JSON.parse(await f.readFile("utf8")), key);
    } finally { await f.close(); }
  }
  async function syncDirectory() { const d = await open(dir, constants.O_RDONLY | constants.O_NOFOLLOW); try { await d.sync(); } finally { await d.close(); } }
  async function insert(path: string, value: ProvisionIntent): Promise<boolean> {
    let f;
    try { f = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return false; throw error; }
    try { await f.writeFile(JSON.stringify(value)); await f.sync(); } finally { await f.close(); }
    await syncDirectory(); return true;
  }
  async function read(key: string) {
    filename(key);
    if (!await checkDirectory()) return undefined;
    const prior = await load(key), completed = await load(key, true);
    if (!completed) return prior;
    if (!prior || completed.state !== "complete" || prior.fingerprint !== completed.fingerprint || (prior.state === "complete" && !sameReceipt(prior.receipt!, completed.receipt!))) return fail();
    return completed;
  }
  return {
    read,
    async claim(value) {
      const desired = intent(value, value.key);
      if (desired.state !== "pending") return fail();
      await checkDirectory(true);
      if (await insert(filename(desired.key), desired)) return { inserted: true, intent: desired };
      const prior = await read(desired.key);
      if (!prior) return fail();
      return { inserted: false, intent: prior };
    },
    async complete(key, fingerprint, value) {
      if (options.readOnly || !fingerprintPattern.test(fingerprint) || !receipt(value)) return fail();
      await checkDirectory();
      const prior = await read(key);
      if (!prior || prior.fingerprint !== fingerprint) return fail();
      if (prior.state === "complete") { if (!sameReceipt(prior.receipt!, value)) return fail(); return; }
      const completed: ProvisionIntent = { key, fingerprint, state: "complete", receipt: structuredClone(value) };
      if (!await insert(filename(key, true), completed)) {
        const existing = await read(key);
        if (existing?.state !== "complete" || !sameReceipt(existing.receipt!, value)) return fail();
      }
    },
  };
}

/** A roster plan can contain a secret callback URL; never print its body to logs. */
export async function writePrivateProvisionPlan(path: string, plan: unknown): Promise<void> {
  const parentPath = await realpath(dirname(resolve(path)));
  const destination = join(parentPath, basename(path));
  const file = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(JSON.stringify(plan, null, 2) + "\n"); await file.sync(); }
  finally { await file.close(); }
  const parent = await open(parentPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await parent.sync(); } finally { await parent.close(); }
}
