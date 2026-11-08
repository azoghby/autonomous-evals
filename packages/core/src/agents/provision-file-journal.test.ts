import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProvisionFileJournal, writePrivateProvisionPlan } from "./provision-file-journal";
const dirs: string[] = [];
const key = "naive-provision:agent:ae-test";
const fingerprint = "a".repeat(64);
const pending = { key, fingerprint, state: "pending" as const };
async function directory() { const p = await mkdtemp(join(tmpdir(), "provision-journal-")); dirs.push(p); return p; }
afterEach(async () => { await Promise.all(dirs.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
describe("durable private provision journal", () => {
  it("persists pending and completion across independent instances without overwriting intent", async () => {
    const dir = await directory(); const a = createProvisionFileJournal(dir);
    expect((await a.claim(pending)).inserted).toBe(true);
    await a.complete(key, fingerprint, { id: "agt_test", version: 1 });
    const b = createProvisionFileJournal(dir);
    expect(await b.read(key)).toEqual({ ...pending, state: "complete", receipt: { id: "agt_test", version: 1 } });
    expect((await b.claim(pending)).inserted).toBe(false);
    expect(JSON.parse(await readFile(join(dir, "naive-provision_agent_ae-test.json"), "utf8")).state).toBe("pending");
    await expect(b.complete(key, fingerprint, { id: "agt_other", version: 1 })).rejects.toThrow();
    await expect(b.complete(key, "b".repeat(64), { id: "agt_test", version: 1 })).rejects.toThrow();
  });
  it("allows only one concurrent creator", async () => {
    const dir = await directory();
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => createProvisionFileJournal(dir).claim(pending)));
    expect(results.filter(r => r.status === "fulfilled" && r.value.inserted)).toHaveLength(1);
    expect(await createProvisionFileJournal(dir).read(key)).toEqual(pending);
  });
  it("never overwrites a conflicting concurrent completion", async () => {
    const dir = await directory(); await createProvisionFileJournal(dir).claim(pending);
    const results = await Promise.allSettled(["agt_one", "agt_two"].map(id => createProvisionFileJournal(dir).complete(key, fingerprint, { id })));
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    const saved = await createProvisionFileJournal(dir).read(key);
    expect(["agt_one", "agt_two"]).toContain(saved?.receipt?.id);
  });
  it("read-only absent journal has no filesystem side effects", async () => {
    const dir = join(await directory(), "absent"); const journal = createProvisionFileJournal(dir, { readOnly: true });
    expect(await journal.read(key)).toBeUndefined();
    await expect(journal.claim(pending)).rejects.toThrow();
    await expect(journal.complete(key, fingerprint, { id: "agt_test" })).rejects.toThrow();
    await expect(stat(dir)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("fences torn writes, malformed receipts and symlinks", async () => {
    const dir = await directory(); const path = join(dir, "naive-provision_agent_ae-test.json");
    await writeFile(path, '{"key":', { mode: 0o600 });
    const j = createProvisionFileJournal(dir);
    await expect(j.claim(pending)).rejects.toThrow();
    await writeFile(path, JSON.stringify({ ...pending, state: "complete", receipt: { id: "agt_test", secret: "must reject" } }));
    await expect(j.read(key)).rejects.toThrow();
    await rm(path); const target = join(dir, "target"); await writeFile(target, JSON.stringify(pending), { mode: 0o600 }); await symlink(target, path);
    await expect(j.read(key)).rejects.toThrow();
    expect(await readFile(target, "utf8")).toBe(JSON.stringify(pending));
  });
  it("rejects path traversal, foreign key and orphan completion", async () => {
    const dir = await directory(); const j = createProvisionFileJournal(dir);
    await expect(j.read("../../secret")).rejects.toThrow();
    await writeFile(join(dir, "naive-provision_agent_ae-test.complete.json"), JSON.stringify({ ...pending, state: "complete", receipt: { id: "agt_test" } }), { mode: 0o600 });
    await expect(j.read(key)).rejects.toThrow();
  });
});

it("writes sensitive plans privately and refuses overwrite", async () => {
  const dir = await directory(); const path = join(dir, "plan.json");
  const plan = { on_idle: "https://example.test/idle/private-token" };
  await writePrivateProvisionPlan(path, plan);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual(plan);
  await expect(writePrivateProvisionPlan(path, {})).rejects.toThrow();
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual(plan);
});
it("creates a nested private journal with resumable intent", async () => {
  const dir = join(await directory(), "nested", "journal");
  await createProvisionFileJournal(dir).claim(pending);
  expect((await stat(dir)).mode & 0o777).toBe(0o700);
  expect(await createProvisionFileJournal(dir).read(key)).toEqual(pending);
});
it("resolves existing parent aliases for private output without following destination symlinks", async () => {
  const dir = await directory(); const alias = join(dir, "alias"); await symlink(dir, alias);
  await writePrivateProvisionPlan(join(alias, "private.json"), { stage: "resources" });
  expect((await stat(join(dir, "private.json"))).mode & 0o777).toBe(0o600);
  await symlink(join(dir, "private.json"), join(dir, "destination.json"));
  await expect(writePrivateProvisionPlan(join(alias, "destination.json"), {})).rejects.toThrow();
});
