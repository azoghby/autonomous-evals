import 'server-only';
import { Pool } from '@neondatabase/serverless';
import { settleCost, type CostSql, type CostTarget } from '@ae/core/db/cost-settlement';

let pool: Pool | undefined;
const sql: CostSql = {
  async transaction(fn) {
    const connectionString = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL is not set');
    pool ??= new Pool({ connectionString, max: 5 });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn({ async query<T>(text: string, params?: unknown[]) {
        const result = await client.query(text, params);
        return { rows: result.rows as T[] };
      } });
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* Preserve the original error; replay reconciles a lost commit acknowledgement. */ }
      throw error;
    } finally { client.release(); }
  },
};
export const recordSettledCost = (target: CostTarget, entry: unknown) => settleCost(sql, target, entry);
