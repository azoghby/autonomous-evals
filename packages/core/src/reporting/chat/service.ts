import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  CHAT_LIMITS, AuthenticatedCallerSchema, ChatScopeSchema, ProgressSnapshotSchema,
  ChatExchangeSchema, ChatError,
  type TrustedAccessPort, type ProgressPort, type ConversationPort, type ChatScope,
} from './types';
import { answerProgressQuestion } from './answers';
import { containsSecret } from '../../agents/redact';

const Id = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const Send = z.object({ jobId: Id, messageId: Id, question: z.string().trim().min(1).max(CHAT_LIMITS.inputCharacters) }).strict();
const History = z.object({ jobId: Id, afterSequence: z.number().int().nonnegative().safe().default(0), limit: z.number().int().min(1).max(50).default(20) }).strict();
const Poll = z.object({ jobId: Id, cursor: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict();
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const result = schema.safeParse(value);
  if (!result.success) throw new ChatError('invalid_input');
  return result.data;
};

/** Server-side only. Ports must be bound to the current request, never supplied by clients. */
export function createProgressChatService(ports: {
  access: TrustedAccessPort; progress: ProgressPort; conversations: ConversationPort;
  /** Current server policy, also applied to immutable stored replay/history. */
  knownSecrets?: readonly string[] | (() => readonly string[]);
}) {
  function screen(value: unknown) {
    const secrets = typeof ports.knownSecrets === 'function' ? ports.knownSecrets() : ports.knownSecrets ?? [];
    if (!Array.isArray(secrets) || secrets.some(s => typeof s !== 'string' || s.length < 4)
      || containsSecret(JSON.stringify(value), secrets)) throw new ChatError('invalid_snapshot');
  }
  async function authorize(jobId: string): Promise<ChatScope> {
    const identity = await ports.access.authenticate();
    if (!identity) throw new ChatError('unauthenticated');
    const caller = AuthenticatedCallerSchema.safeParse(identity);
    if (!caller.success) throw new ChatError('unauthenticated');
    const resolved = await ports.access.resolveAuthorizedJob(caller.data, jobId);
    const scope = ChatScopeSchema.safeParse(resolved);
    if (!scope.success || scope.data.subjectId !== caller.data.subjectId || scope.data.jobId !== jobId) {
      throw new ChatError('not_found');
    }
    return scope.data;
  }
  async function snapshot(scope: ChatScope) {
    const result = ProgressSnapshotSchema.safeParse(await ports.progress.read(scope));
    if (!result.success || result.data.jobId !== scope.jobId) throw new ChatError('invalid_snapshot');
    // Duplicate records would inflate counts/costs; inconsistent freshness is not progress.
    for (const records of [result.data.milestones, result.data.findings, result.data.blockers, result.data.costs]) {
      if (new Set(records.map(record => record.id)).size !== records.length) throw new ChatError('invalid_snapshot');
    }
    if (result.data.milestones.some(record => Date.parse(record.at) > Date.parse(result.data.observedAt))) {
      throw new ChatError('invalid_snapshot');
    }
    const total = result.data.costs.reduce((sum, item) => sum + item.microUsd, 0);
    if (!Number.isSafeInteger(total)) throw new ChatError('invalid_snapshot');
    return result.data;
  }
  function exchange(value: unknown) {
    const result = ChatExchangeSchema.safeParse(value);
    if (!result.success) throw new ChatError('storage_error');
    screen(result.data);
    return result.data;
  }
  // Never surface raw port exceptions (which can contain database/provider credentials).
  async function safely<T>(run: () => Promise<T>): Promise<T> {
    try { return await run(); }
    catch (error) { if (error instanceof ChatError) throw error; throw new ChatError('storage_error'); }
  }
  return {
    send(input: unknown) {
      return safely(async () => {
        const request = parse(Send, input);
        if (Buffer.byteLength(request.question, 'utf8') > CHAT_LIMITS.inputBytes) throw new ChatError('invalid_input');
        const scope = await authorize(request.jobId);
        const inputDigest = digest(request.question);
        const previous = await ports.conversations.get(scope, request.messageId);
        if (previous !== null) {
          const stored = exchange(previous);
          if (stored.messageId !== request.messageId || stored.inputDigest !== inputDigest) throw new ChatError('conflict');
          return stored;
        }
        const reply = answerProgressQuestion(request.question, await snapshot(scope));
        screen(reply);
        // Append must atomically choose the first writer. Always return its result, not our candidate.
        const stored = exchange(await ports.conversations.append(scope, { messageId: request.messageId, inputDigest, reply }));
        if (stored.messageId !== request.messageId || stored.inputDigest !== inputDigest) throw new ChatError('conflict');
        return stored;
      });
    },
    history(input: unknown) {
      return safely(async () => {
        const request = parse(History, input);
        const scope = await authorize(request.jobId);
        const rows = await ports.conversations.list(scope, { afterSequence: request.afterSequence, limit: request.limit });
        if (!Array.isArray(rows) || rows.length > request.limit) throw new ChatError('storage_error');
        const messages = rows.map(exchange);
        let sequence = request.afterSequence;
        for (const row of messages) {
          if (row.sequence <= sequence) throw new ChatError('storage_error');
          sequence = row.sequence;
        }
        return { messages, nextAfterSequence: sequence };
      });
    },
    poll(input: unknown) {
      return safely(async () => {
        const request = parse(Poll, input);
        const scope = await authorize(request.jobId);
        const data = await snapshot(scope);
        // Scope binding prevents a cursor from being used as a cross-tenant change oracle.
        const cursor = digest(JSON.stringify([scope, data]));
        const result = { cursor, changed: cursor !== request.cursor, asOf: data.observedAt,
          ...(cursor !== request.cursor ? { reply: answerProgressQuestion('overview', data) } : {}) };
        screen(result);
        return result;
      });
    },
  };
}
