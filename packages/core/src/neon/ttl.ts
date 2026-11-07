import { createNeonClient, toRfc3339, type NeonClient } from "./api";

export const BRANCH_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const NEON_MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** deliveredAt + 7 days. Pure, for testing. */
export function branchExpiry(deliveredAt: Date): Date {
  return new Date(deliveredAt.getTime() + BRANCH_TTL_MS);
}

/**
 * Safety net: have Neon auto-delete the job branch 7 days after delivery. The +48h cleanup cron
 * stays the source of truth; this only catches leaks. Throws if the computed time is in the past
 * or beyond Neon's 30-day maximum (the API would reject it anyway). Returns the expiry applied.
 */
export async function applyBranchTtl(
  branchId: string,
  deliveredAt: Date,
  client: NeonClient = createNeonClient(),
  now: Date = new Date(),
): Promise<Date> {
  const expiresAt = branchExpiry(deliveredAt);
  if (expiresAt.getTime() <= now.getTime()) throw new Error("applyBranchTtl: expiry would be in the past");
  if (expiresAt.getTime() - now.getTime() > NEON_MAX_TTL_MS) throw new Error("applyBranchTtl: expiry exceeds Neon's 30-day maximum");
  await client.setBranchExpiration(branchId, expiresAt);
  return expiresAt;
}

export { toRfc3339 };
