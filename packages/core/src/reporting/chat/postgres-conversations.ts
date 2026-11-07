import {
  ChatError, ChatScopeSchema, ChatExchangeSchema, ChatAppendInputSchema, ChatHistoryQuerySchema,
  type ConversationPort, type ChatScope, type ChatExchange,
} from './types.js';

/** Structurally compatible with AgentTransactionalSql and pooledCalendarDatabase.
 * transaction MUST pin one connection, use READ COMMITTED, commit only on success,
 * roll back failures and never retry callbacks. Independent pool.query/Neon HTTP
 * calls are not a transaction. Configure database/lock timeouts on the server pool.
 */
export interface ConversationSqlExecutor {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}
export interface ConversationTransactionalSql extends ConversationSqlExecutor {
  transaction<T>(fn: (tx: ConversationSqlExecutor) => Promise<T>): Promise<T>;
}

type Row = {
  subject_id: string; job_id: string; message_id: string;
  input_digest: string; reply: unknown; sequence: unknown;
};
const columns = 'subject_id, job_id, message_id, input_digest, reply, sequence';
const failure = () => new ChatError('storage_error');
function sequence(value: unknown, minimum: number): number {
  if (!(typeof value === 'number' || (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)))) throw failure();
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < minimum) throw failure();
  return n;
}
function exchange(row: Row, scope: ChatScope, messageId?: string): ChatExchange {
  if (row.subject_id !== scope.subjectId || row.job_id !== scope.jobId ||
      (messageId !== undefined && row.message_id !== messageId)) throw failure();
  return ChatExchangeSchema.parse({
    messageId: row.message_id, inputDigest: row.input_digest,
    reply: row.reply, sequence: sequence(row.sequence, 1),
  });
}
async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch { throw failure(); }
}

/** Server-only durable private chat storage; schema deployment is an explicit app operation. */
export function createPostgresConversationPort(db: ConversationTransactionalSql): ConversationPort {
  return {
    get: (rawScope, messageId) => guarded(async () => {
      const scope = ChatScopeSchema.parse(rawScope);
      ChatExchangeSchema.shape.messageId.parse(messageId);
      const { rows } = await db.query<Row>(`SELECT ${columns} FROM reporting_chat_exchanges
        WHERE subject_id = $1 AND job_id = $2 AND message_id = $3`,
      [scope.subjectId, scope.jobId, messageId]);
      if (rows.length > 1) throw failure();
      return rows.length ? exchange(rows[0]!, scope, messageId) : null;
    }),
    list: (rawScope, rawQuery) => guarded(async () => {
      const scope = ChatScopeSchema.parse(rawScope);
      const query = ChatHistoryQuerySchema.parse(rawQuery);
      const { rows } = await db.query<Row>(`SELECT ${columns} FROM reporting_chat_exchanges
        WHERE subject_id = $1 AND job_id = $2 AND sequence > $3
        ORDER BY sequence ASC LIMIT $4`,
      [scope.subjectId, scope.jobId, query.afterSequence, query.limit]);
      if (rows.length > query.limit) throw failure();
      let previous = query.afterSequence;
      const ids = new Set<string>();
      return rows.map(row => {
        const saved = exchange(row, scope);
        if (saved.sequence <= previous || ids.has(saved.messageId)) throw failure();
        previous = saved.sequence;
        ids.add(saved.messageId);
        return saved;
      });
    }),
    append: (rawScope, rawInput) => guarded(async () => {
      // Parse before any await, so caller mutations cannot change the write intent.
      const scope = ChatScopeSchema.parse(rawScope);
      const input = ChatAppendInputSchema.parse(rawInput);
      const reply = JSON.stringify(input.reply);
      return db.transaction(async tx => {
        const key = [scope.subjectId, scope.jobId];
        // Unique key arbitrates creation too: competing first appends wait here.
        await tx.query(`INSERT INTO reporting_chat_scopes(subject_id, job_id, last_sequence)
          VALUES ($1, $2, 0) ON CONFLICT (subject_id, job_id) DO NOTHING`, key);
        const locked = await tx.query<{ last_sequence: unknown }>(`SELECT last_sequence FROM reporting_chat_scopes
          WHERE subject_id = $1 AND job_id = $2 FOR UPDATE`, key);
        if (locked.rows.length !== 1) throw failure();
        const last = sequence(locked.rows[0]!.last_sequence, 0);
        // Separate statement after the lock sees the preceding writer's commit at READ COMMITTED.
        const prior = await tx.query<Row>(`SELECT ${columns} FROM reporting_chat_exchanges
          WHERE subject_id = $1 AND job_id = $2 AND message_id = $3`, [...key, input.messageId]);
        if (prior.rows.length > 1) throw failure();
        if (prior.rows.length) return exchange(prior.rows[0]!, scope, input.messageId);
        if (last === Number.MAX_SAFE_INTEGER) throw failure();
        const next = last + 1;
        const allocated = await tx.query<{ last_sequence: unknown }>(`UPDATE reporting_chat_scopes SET last_sequence = $3
          WHERE subject_id = $1 AND job_id = $2 RETURNING last_sequence`, [...key, next]);
        if (allocated.rows.length !== 1 || sequence(allocated.rows[0]!.last_sequence, 1) !== next) throw failure();
        const saved = await tx.query<Row>(`INSERT INTO reporting_chat_exchanges
          (subject_id, job_id, message_id, input_digest, reply, sequence)
          VALUES ($1, $2, $3, $4, $5::jsonb, $6) RETURNING ${columns}`,
        [...key, input.messageId, input.inputDigest, reply, next]);
        if (saved.rows.length !== 1) throw failure();
        const result = exchange(saved.rows[0]!, scope, input.messageId);
        if (result.sequence !== next) throw failure();
        return result;
      });
    }),
  };
}
