/** Durable local adapter for a persistent, single-host filesystem. Vercel needs a database adapter. */
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rmdir, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  ChatError, ChatScopeSchema, ChatExchangeSchema, ChatAppendInputSchema, ChatHistoryQuerySchema,
  type ConversationPort, type ChatScope,
} from "./types.js";

const MAX_EXCHANGES = 1_000;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const identifier = ChatExchangeSchema.shape.messageId;
const appendSchema = ChatAppendInputSchema;
const historySchema = ChatHistoryQuerySchema;
const stateSchema = z.strictObject({
  version: z.literal(1), scope: ChatScopeSchema,
  exchanges: z.array(ChatExchangeSchema).max(MAX_EXCHANGES),
}).superRefine((state, ctx) => {
  const ids = new Set<string>();
  state.exchanges.forEach((exchange, index) => {
    if (exchange.sequence !== index + 1 || ids.has(exchange.messageId)) {
      ctx.addIssue({ code: "custom", message: "Invalid conversation sequence" });
    }
    ids.add(exchange.messageId);
  });
});

const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";
const storageError = () => new ChatError("storage_error");
const clone = <T>(value: T): T => structuredClone(value);

export function createFileConversationPort(directory: string): ConversationPort {
  const root = resolve(directory);
  async function location(rawScope: ChatScope) {
    const scope = ChatScopeSchema.parse(rawScope);
    const key = createHash("sha256").update(JSON.stringify([scope.subjectId, scope.jobId])).digest("hex");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const path = join(root, key);
    await mkdir(path, { recursive: true, mode: 0o700 });
    if (!(await lstat(path)).isDirectory() || (await lstat(path)).isSymbolicLink()) throw storageError();
    return { scope, path, file: join(path, "conversation.json") };
  }
  async function read(file: string, scope: ChatScope) {
    let handle;
    try {
      handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (missing(error)) return stateSchema.parse({ version: 1, scope, exchanges: [] });
      throw error;
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw storageError();
      // Fixed-size read prevents a concurrently expanded file from creating an unbounded allocation.
      const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_FILE_BYTES) throw storageError();
      const state = stateSchema.parse(JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")));
      if (state.scope.subjectId !== scope.subjectId || state.scope.jobId !== scope.jobId) throw storageError();
      return state;
    } finally { await handle.close(); }
  }
  async function guarded<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch { throw storageError(); }
  }
  return {
    get: (scope, messageId) => guarded(async () => {
      identifier.parse(messageId);
      const loc = await location(scope);
      return clone((await read(loc.file, loc.scope)).exchanges.find((row) => row.messageId === messageId) ?? null);
    }),
    list: (scope, query) => guarded(async () => {
      const parsed = historySchema.parse(query);
      const loc = await location(scope);
      return clone((await read(loc.file, loc.scope)).exchanges
        .filter((row) => row.sequence > parsed.afterSequence).slice(0, parsed.limit));
    }),
    append: (scope, input) => guarded(async () => {
      const parsed = appendSchema.parse(input);
      const loc = await location(scope);
      const lock = join(loc.path, "append.lock");
      let acquired = false;
      // Never steal stale locks: after a crash, operator recovery is required.
      for (let attempt = 0; attempt < 100; attempt++) {
        try { await mkdir(lock, { mode: 0o700 }); acquired = true; break; }
        catch (error) {
          if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
          await new Promise((done) => setTimeout(done, 10));
        }
      }
      if (!acquired) throw storageError();
      let temporary: string | undefined;
      try {
        const state = await read(loc.file, loc.scope);
        const existing = state.exchanges.find((row) => row.messageId === parsed.messageId);
        if (existing) return clone(existing);
        if (state.exchanges.length >= MAX_EXCHANGES) throw storageError();
        const row = ChatExchangeSchema.parse({ ...parsed, sequence: state.exchanges.length + 1 });
        state.exchanges.push(row);
        const data = JSON.stringify(state);
        if (Buffer.byteLength(data) > MAX_FILE_BYTES) throw storageError();
        temporary = join(loc.path, `${randomUUID()}.tmp`);
        const handle = await open(temporary, "wx", 0o600);
        try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
        await rename(temporary, loc.file);
        temporary = undefined;
        const dirHandle = await open(loc.path, "r");
        try { await dirHandle.sync(); } finally { await dirHandle.close(); }
        return clone(row);
      } finally {
        if (temporary) await unlink(temporary).catch(() => undefined);
        await rmdir(lock);
      }
    }),
  };
}
