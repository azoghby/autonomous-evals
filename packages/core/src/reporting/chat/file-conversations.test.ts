import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFileConversationPort } from "./file-conversations.js";
import type { ChatAppendInput } from "./types.js";

const directories: string[] = [];
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "progress-chat-test-"));
  directories.push(dir);
  return { dir, port: createFileConversationPort(dir) };
}
afterEach(async () => { await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const scope = { subjectId: "alice", jobId: "job-1" };
const row = (messageId = "msg-1"): ChatAppendInput => ({
  messageId, inputDigest: createHash("sha256").update(messageId).digest("hex"),
  reply: { asOf: "2026-11-07T00:00:00Z", topic: "progress", text: "Persisted state: running.", evidenceRefs: ["state-1"], unknowns: ["ETA unknown."] },
});

describe("durable private file conversations", () => {
  it("survives adapter recreation with tenant and job partitioning", async () => {
    const { dir, port } = await fixture();
    const saved = await port.append(scope, row());
    const restarted = createFileConversationPort(dir);
    expect(await restarted.get(scope, "msg-1")).toEqual(saved);
    expect(await restarted.get({ ...scope, subjectId: "mallory" }, "msg-1")).toBeNull();
    expect(await restarted.get({ ...scope, jobId: "job-2" }, "msg-1")).toBeNull();
    expect(await restarted.list({ ...scope, subjectId: "mallory" }, { afterSequence: 0, limit: 10 })).toEqual([]);
  });
  it("serializes racing adapters and preserves the first committed reply on replay", async () => {
    const { dir, port } = await fixture();
    const other = createFileConversationPort(dir);
    const results = await Promise.all(Array.from({ length: 12 }, (_, index) =>
      (index % 2 ? port : other).append(scope, { ...row(), reply: { ...row().reply, text: `candidate-${index}` } })));
    expect(new Set(results.map((entry) => entry.reply.text)).size).toBe(1);
    expect(results.every((entry) => entry.sequence === 1)).toBe(true);
    const changed = { ...row(), inputDigest: "f".repeat(64) };
    expect(await other.append(scope, changed)).toEqual(results[0]);
    expect(await port.list(scope, { afterSequence: 0, limit: 50 })).toHaveLength(1);
  });
  it("paginates strict ascending sequences without duplicates and bounds page size", async () => {
    const { port } = await fixture();
    await Promise.all(["m1", "m2", "m3"].map((id) => port.append(scope, row(id))));
    const first = await port.list(scope, { afterSequence: 0, limit: 2 });
    const second = await port.list(scope, { afterSequence: first[1]!.sequence, limit: 2 });
    expect([...first, ...second].map((entry) => entry.sequence)).toEqual([1, 2, 3]);
    await expect(port.list(scope, { afterSequence: 0, limit: 51 })).rejects.toMatchObject({ code: "storage_error" });
    await expect(port.list(scope, { afterSequence: -1, limit: 1 })).rejects.toMatchObject({ code: "storage_error" });
  });
  it("hashes path-like subject identities rather than interpreting them as filesystem paths", async () => {
    const { dir, port } = await fixture();
    const hostileScope = { ...scope, subjectId: "../../outside/secret" };
    await port.append(hostileScope, row());
    expect((await readdir(dir)).every((entry) => /^[a-f0-9]{64}$/.test(entry))).toBe(true);
    expect(await port.get(scope, "msg-1")).toBeNull();
  });
  it("fails closed on corrupted or cross-tenant persisted rows with fixed errors", async () => {
    const { dir, port } = await fixture();
    await port.append(scope, row());
    const [partition] = await readdir(dir);
    const path = join(dir, partition!, "conversation.json");
    const state = JSON.parse(await readFile(path, "utf8"));
    state.scope.subjectId = "mallory";
    await writeFile(path, JSON.stringify(state));
    await expect(port.get(scope, "msg-1")).rejects.toMatchObject({ code: "storage_error", message: "Conversation storage is unavailable or invalid." });
    await writeFile(path, "provider apiKey=secret");
    await expect(port.get(scope, "msg-1")).rejects.toMatchObject({ code: "storage_error", message: "Conversation storage is unavailable or invalid." });
  });
});
