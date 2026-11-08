/*
 * x402 demo: an AI agent pays for its own eval with Base Sepolia (TESTNET) USDC, no human in the loop.
 *
 *   npx tsx scripts/x402-pay-demo.ts --address              # print the payer address + balances (fund it first)
 *   npx tsx scripts/x402-pay-demo.ts <jobId>                # 402 -> sign -> retry -> settled
 *
 * Env (read from .env / apps/web/.env.local):
 *   X402_PAYER_PRIVATE_KEY  0x... testnet-only payer key. Fund its address with Base Sepolia USDC from
 *                           https://faucet.circle.com (network "Base Sepolia"). No ETH needed: the facilitator pays gas.
 *   AE_API_KEY              the job owner's API key (same key as the MCP server)
 *   AE_BASE_URL             app origin, default APP_URL or http://localhost:3000
 *   X402_MAX_USD            client-side spend cap per payment, default 25
 * The job must be a test-environment job with a fixed-price quote in state quoted/awaiting_payment.
 */
import { config } from "dotenv";
import { createPublicClient, formatUnits, http, parseAbi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from "@x402/core/http";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { getDefaultAsset } from "@x402/evm";

for (const f of [".env", "apps/web/.env.local"]) config({ path: f, override: false, quiet: true });

const NETWORK = "eip155:84532" as const;
const USDC = getDefaultAsset(NETWORK, "USDC");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function need(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

async function balances(address: Hex) {
  const client = createPublicClient({ chain: baseSepolia, transport: http() });
  const [eth, usdc] = await Promise.all([
    client.getBalance({ address }),
    client.readContract({ address: USDC.asset as Hex, abi: parseAbi(["function balanceOf(address) view returns (uint256)"]), functionName: "balanceOf", args: [address] }),
  ]);
  return { eth: formatUnits(eth, 18), usdc: formatUnits(usdc, USDC.decimals) };
}

async function main() {
  const pk = need("X402_PAYER_PRIVATE_KEY");
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) throw new Error("X402_PAYER_PRIVATE_KEY must be a 0x-prefixed 32-byte hex key");
  const account = privateKeyToAccount(pk as Hex);
  const bal = await balances(account.address);
  console.log(`payer ${account.address} on Base Sepolia: ${bal.usdc} USDC, ${bal.eth} ETH`);
  if (process.argv.includes("--address")) {
    console.log("Fund this address with test USDC at https://faucet.circle.com (select Base Sepolia).");
    return;
  }

  const jobId = process.argv[2];
  if (!jobId || !UUID.test(jobId)) throw new Error("usage: npx tsx scripts/x402-pay-demo.ts <jobId>");
  const apiKey = need("AE_API_KEY");
  const base = (process.env.AE_BASE_URL ?? process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
  const url = `${base}/api/x402/jobs/${jobId}/pay`;
  const init = { method: "POST", headers: { Authorization: `Bearer ${apiKey}` } };

  // 1. Ask: what does this cost? (402 + PAYMENT-REQUIRED)
  const probe = await fetch(url, init);
  if (probe.status !== 402) {
    console.log(`server answered ${probe.status} (expected 402):`, await probe.text());
    return;
  }
  const required = decodePaymentRequiredHeader(probe.headers.get("PAYMENT-REQUIRED") ?? "");
  const req = required.accepts[0];
  console.log(`402 Payment Required: ${formatUnits(BigInt(req.amount), USDC.decimals)} USDC to ${req.payTo} on ${req.network}`);
  console.log(`  ${required.resource.description}`);

  // 2-3. Sign an EIP-3009 USDC authorization with the official client and retry (handled by @x402/fetch).
  const maxUsd = Number(process.env.X402_MAX_USD ?? "25");
  const payFetch = wrapFetchWithPaymentFromConfig(fetch, {
    schemes: [{ network: NETWORK, client: new ExactEvmScheme(account) }],
    spendControls: { maxAmountPerPayment: `$${maxUsd}` },
  });
  const paid = await payFetch(url, init);
  const body = await paid.json().catch(() => ({}));
  if (paid.status !== 200) {
    console.log(`payment failed (${paid.status}):`, JSON.stringify(body, null, 2));
    process.exitCode = 1;
    return;
  }
  const header = paid.headers.get("PAYMENT-RESPONSE");
  const settlement = header ? decodePaymentResponseHeader(header) : null;
  console.log(`paid: tx ${settlement?.transaction ?? body.txHash}`);
  console.log(`  ${body.explorerUrl ?? ""}`);
  console.log(`  payment ${body.paymentId}, outcome ${body.outcome}. ${body.note ?? ""}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
