import { handleX402Pay } from "@/server/x402-pay";

export const dynamic = "force-dynamic";
/** verify + on-chain settle on Base Sepolia usually takes a few seconds; leave headroom. */
export const maxDuration = 60;

/**
 * x402 pay endpoint for AI agents (TESTNET ONLY, Base Sepolia USDC). See handleX402Pay.
 * POST without a payment header -> 402 + PAYMENT-REQUIRED; retry with PAYMENT-SIGNATURE to pay.
 */
export async function POST(req: Request, ctx: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await ctx.params;
  return handleX402Pay(req, jobId);
}
