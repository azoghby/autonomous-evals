/**
 * x402 (HTTP 402 + USDC) payments, protocol v2, TESTNET ONLY (Base Sepolia, CAIP-2 eip155:84532).
 *
 * Pure helpers: build the PaymentRequired object for a quote, check a client payment payload against it,
 * and map a facilitator settlement to a payment row. Verification and settlement go through the public
 * x402 facilitator (default https://x402.org/facilitator, the @x402/core default) via HTTPFacilitatorClient.
 */
import { HTTPFacilitatorClient } from "@x402/core/http";
import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequired, PaymentRequirements, SettleResponse } from "@x402/core/types";
import { getDefaultAsset } from "@x402/evm";

export type { FacilitatorClient, PaymentPayload, PaymentRequired, PaymentRequirements, SettleResponse };

/** Base Sepolia. Mainnet is deliberately not supported yet. */
export const X402_NETWORK = "eip155:84532" as const;
export const X402_SCHEME = "exact" as const;
export const X402_VERSION = 2;
/** Same default @x402/core's HTTPFacilitatorClient uses; override with X402_FACILITATOR_URL. */
export const DEFAULT_X402_FACILITATOR_URL = "https://x402.org/facilitator";
/** Recorded in payments.currency for x402 rows. paymentMatchesQuote treats USDC as USD (1:1 stablecoin). */
export const X402_CURRENCY = "usdc";
/** payments.stripe_checkout_session_id prefix for x402 rows (column is NOT NULL + unique: doubles as the tx-hash idempotency key). */
export const X402_SESSION_PREFIX = "x402:";
const MAX_TIMEOUT_SECONDS = 300;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

/** USDC on Base Sepolia, from @x402/evm's default asset table (address, decimals, EIP-712 domain name/version). */
export function x402Asset() {
  return getDefaultAsset(X402_NETWORK, "USDC");
}

/** Integer cents -> USDC atomic units (6 decimals: 1 cent = 10_000 units). */
export function centsToAtomic(cents: number): string {
  if (!Number.isInteger(cents) || cents <= 0) throw new Error("cents must be a positive integer");
  const { decimals } = x402Asset();
  return (BigInt(cents) * BigInt(10) ** BigInt(decimals - 2)).toString();
}

/** USDC atomic units -> integer cents, or null when the amount is not a whole number of cents. */
export function atomicToCents(atomic: string): number | null {
  if (!/^\d+$/.test(atomic)) return null;
  const unit = BigInt(10) ** BigInt(x402Asset().decimals - 2);
  const v = BigInt(atomic);
  if (v % unit !== BigInt(0)) return null;
  const cents = v / unit;
  return cents <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(cents) : null;
}

export const isEvmAddress = (s: string | undefined): s is string => !!s && EVM_ADDRESS.test(s);
export const isTxHash = (s: string | undefined): s is string => !!s && TX_HASH.test(s);

export interface X402QuoteArgs {
  priceCents: number;
  payTo: string;
  resourceUrl: string;
  description: string;
}

export function buildRequirements(a: X402QuoteArgs): PaymentRequirements {
  if (!isEvmAddress(a.payTo)) throw new Error("payTo must be an EVM address");
  const asset = x402Asset();
  return {
    scheme: X402_SCHEME,
    network: X402_NETWORK,
    asset: asset.asset,
    amount: centsToAtomic(a.priceCents),
    payTo: a.payTo,
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    // EIP-712 domain of the USDC contract, needed by the client to sign the EIP-3009 authorization.
    extra: { name: asset.name, version: asset.version },
  };
}

export function buildPaymentRequired(a: X402QuoteArgs, error?: string): PaymentRequired {
  return {
    x402Version: X402_VERSION,
    ...(error ? { error } : {}),
    resource: { url: a.resourceUrl, description: a.description, mimeType: "application/json" },
    accepts: [buildRequirements(a)],
  };
}

/**
 * Exact match of what the client signed (`accepted`) against what we require. Checked BEFORE verify/settle
 * so a wrong amount, asset, network or recipient is never charged. Returns a reason or null.
 */
export function payloadMismatch(payload: PaymentPayload, req: PaymentRequirements, resourceUrl?: string): string | null {
  if (payload.x402Version !== X402_VERSION) return `unsupported x402Version ${String(payload.x402Version)} (expected ${X402_VERSION})`;
  const acc = payload.accepted;
  if (!acc) return "payment payload has no accepted requirements";
  if (acc.scheme !== req.scheme) return `scheme must be ${req.scheme}`;
  if (acc.network !== req.network) return `network must be ${req.network}`;
  if (String(acc.asset).toLowerCase() !== req.asset.toLowerCase()) return "asset must be USDC on Base Sepolia";
  if (String(acc.payTo).toLowerCase() !== req.payTo.toLowerCase()) return "payTo does not match";
  if (String(acc.amount) !== req.amount) return `amount mismatch: quote requires ${req.amount} atomic USDC, payment offers ${String(acc.amount)}`;
  // Resource binding: a payment signed for another resource must not unlock this job.
  if (resourceUrl !== undefined && payload.resource?.url !== undefined && payload.resource.url !== resourceUrl) return "resource does not match this job's pay endpoint";
  return null;
}

export interface X402PaymentValues {
  txHash: string;
  network: string;
  payer: string | null;
  amountAtomic: string;
  /** Cents actually settled; a non-cent or different amount makes confirmAndResume treat it as amount_mismatch. */
  amountCents: number;
}

/** Maps a successful settlement to what we record. Throws if the facilitator response is unusable. */
export function settlementValues(settle: SettleResponse, req: PaymentRequirements): X402PaymentValues {
  if (!settle.success) throw new Error(`settlement failed: ${settle.errorReason ?? "unknown"}`);
  if (!isTxHash(settle.transaction)) throw new Error("settlement returned no transaction hash");
  if (settle.network !== req.network) throw new Error(`settlement on unexpected network ${settle.network}`);
  const amountAtomic = settle.amount ?? req.amount;
  return {
    txHash: settle.transaction.toLowerCase(),
    network: settle.network,
    payer: settle.payer ?? null,
    amountAtomic,
    amountCents: atomicToCents(amountAtomic) ?? 0,
  };
}

export const x402SessionKey = (network: string, txHash: string) => `${X402_SESSION_PREFIX}${network}:${txHash.toLowerCase()}`;
export const isX402SessionKey = (s: string | null | undefined) => !!s && s.startsWith(X402_SESSION_PREFIX);

/** Path of the web app's x402 pay endpoint for a job. */
export const x402PayPath = (jobId: string) => `/api/x402/jobs/${jobId}/pay`;

export function explorerTxUrl(txHash: string): string {
  return `https://sepolia.basescan.org/tx/${txHash}`;
}

let cachedFacilitator: FacilitatorClient | undefined;
/** Public x402 facilitator client (no auth needed on testnet). */
export function x402Facilitator(): FacilitatorClient {
  cachedFacilitator ??= new HTTPFacilitatorClient({
    url: process.env.X402_FACILITATOR_URL?.trim() || DEFAULT_X402_FACILITATOR_URL,
    timeoutMs: 45_000,
  });
  return cachedFacilitator;
}
