// Offline provider boundary double. Gateway implementation/credentials are never loaded.
import type { z } from 'zod';
import type { ServiceContext } from '../src/contracts/services';
export class GatewayError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
interface Args { model?: string; system?: string; prompt: string; ctx: Pick<ServiceContext, 'budgetMicroUsd' | 'recordCost'>; agent?: 'commercial' | 'engineer' | 'investigator' | 'operator' | 'judge'; maxOutputTokens?: number; temperature?: number }
interface Result { text: string; provider: 'vercel' | 'neon'; model: string; inputTokens: number; outputTokens: number; microUsd: number; costBasis: 'gateway_reported' | 'list_price_estimate'; latencyMs: number }
export async function generateStructured<T>(_args: Args & { schema: z.ZodType<T> }): Promise<Result & { object: T }> { throw new Error('OFFLINE_GATEWAY_FORBIDDEN'); }
export async function generateText(_args: Args): Promise<Result> { throw new Error('OFFLINE_GATEWAY_FORBIDDEN'); }
export function assertNoCredentials(..._texts: Array<string | undefined>): void { /* Not assessed: production credential guard excluded. */ }
