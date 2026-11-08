import { describe, expect, it } from "vitest";
import { x402Client } from "@x402/core/client";
import { x402HTTPClient, decodePaymentRequiredHeader, encodePaymentRequiredHeader } from "@x402/core/http";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { paymentMatchesQuote } from "../contracts/index";
import {
  atomicToCents, buildPaymentRequired, buildRequirements, centsToAtomic, payloadMismatch, settlementValues,
  X402_NETWORK, type PaymentPayload,
} from "./x402";

const PAY_TO = "0x1111111111111111111111111111111111111111";
const args = { priceCents: 500, payTo: PAY_TO, resourceUrl: "https://ae.test/api/x402/jobs/j/pay", description: "eval" };
const TX = `0x${"ab".repeat(32)}`;

describe("x402 amounts", () => {
  it("converts cents to 6-decimal USDC atomic units and back", () => {
    expect(centsToAtomic(500)).toBe("5000000");
    expect(atomicToCents("5000000")).toBe(500);
    expect(atomicToCents("5000001")).toBeNull();
    expect(atomicToCents("-1")).toBeNull();
    expect(() => centsToAtomic(0)).toThrow();
    expect(() => centsToAtomic(1.5)).toThrow();
  });
});

describe("buildPaymentRequired", () => {
  it("returns x402 v2 exact/Base Sepolia USDC requirements for the quote price", () => {
    const pr = buildPaymentRequired(args);
    expect(pr).toMatchObject({
      x402Version: 2,
      resource: { url: args.resourceUrl, description: "eval", mimeType: "application/json" },
      accepts: [{
        scheme: "exact", network: "eip155:84532", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        amount: "5000000", payTo: PAY_TO, extra: { name: "USDC", version: "2" },
      }],
    });
    expect(pr.accepts[0].maxTimeoutSeconds).toBeGreaterThan(0);
    expect(decodePaymentRequiredHeader(encodePaymentRequiredHeader(pr))).toEqual(pr);
  });
  it("rejects a non-address payTo", () => {
    expect(() => buildRequirements({ ...args, payTo: "nope" })).toThrow();
  });
});

describe("payloadMismatch", () => {
  const req = buildRequirements(args);
  const payload = (over: Partial<PaymentPayload["accepted"]> = {}, v = 2) =>
    ({ x402Version: v, resource: { url: args.resourceUrl }, accepted: { ...req, ...over }, payload: {} }) as PaymentPayload;
  it("accepts an exact match (address case-insensitive)", () => {
    expect(payloadMismatch(payload({ payTo: PAY_TO.toUpperCase().replace("0X", "0x") }), req)).toBeNull();
  });
  it("rejects wrong amount, asset, network, payTo, version", () => {
    expect(payloadMismatch(payload({ amount: "4999999" }), req)).toMatch(/amount mismatch/);
    expect(payloadMismatch(payload({ amount: "5000001" }), req)).toMatch(/amount mismatch/);
    expect(payloadMismatch(payload({ asset: "0x2222222222222222222222222222222222222222" }), req)).toMatch(/asset/);
    expect(payloadMismatch(payload({ network: "eip155:8453" }), req)).toMatch(/network/);
    expect(payloadMismatch(payload({ payTo: "0x3333333333333333333333333333333333333333" }), req)).toMatch(/payTo/);
    expect(payloadMismatch(payload({}, 1), req)).toMatch(/x402Version/);
  });
  it("binds the payment to the resource url when present", () => {
    expect(payloadMismatch(payload(), req, args.resourceUrl)).toBeNull();
    const other = { ...payload(), resource: { url: "https://ae.test/api/x402/jobs/OTHER/pay" } } as PaymentPayload;
    expect(payloadMismatch(other, req, args.resourceUrl)).toMatch(/resource/);
  });
  it("matches what the official x402 client signs for our 402 (real EIP-3009 signature, no network)", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const client = new x402HTTPClient(x402Client.fromConfig({
      schemes: [{ network: X402_NETWORK, client: new ExactEvmScheme(account) }], spendControls: { maxAmountPerPayment: "$25" },
    }));
    const pr = buildPaymentRequired(args);
    const parsed = client.getPaymentRequiredResponse((n) => (n === "PAYMENT-REQUIRED" ? encodePaymentRequiredHeader(pr) : null));
    const signed = await client.createPaymentPayload(parsed);
    expect(payloadMismatch(signed, req)).toBeNull();
    expect(signed.payload).toMatchObject({ authorization: { from: account.address, to: PAY_TO, value: "5000000" } });
  });
});

describe("settlementValues", () => {
  const req = buildRequirements(args);
  it("maps a successful settlement", () => {
    expect(settlementValues({ success: true, transaction: TX, network: X402_NETWORK, payer: "0xp" }, req))
      .toEqual({ txHash: TX, network: X402_NETWORK, payer: "0xp", amountAtomic: "5000000", amountCents: 500 });
  });
  it("records a differing settled amount so confirmAndResume flags it", () => {
    expect(settlementValues({ success: true, transaction: TX, network: X402_NETWORK, amount: "4000000" }, req).amountCents).toBe(400);
  });
  it("throws on failure, missing tx hash or wrong network", () => {
    expect(() => settlementValues({ success: false, transaction: "", network: X402_NETWORK }, req)).toThrow();
    expect(() => settlementValues({ success: true, transaction: "0x12", network: X402_NETWORK }, req)).toThrow();
    expect(() => settlementValues({ success: true, transaction: TX, network: "eip155:8453" }, req)).toThrow();
  });
});

describe("paymentMatchesQuote with USDC", () => {
  const quote = { pricingMode: "fixed", priceCents: 500, capCents: null };
  it("treats usdc as usd, still exact on amount", () => {
    expect(paymentMatchesQuote({ amountCents: 500, currency: "usdc" }, quote)).toBe(true);
    expect(paymentMatchesQuote({ amountCents: 499, currency: "usdc" }, quote)).toBe(false);
    expect(paymentMatchesQuote({ amountCents: 500, currency: "eur" }, quote)).toBe(false);
  });
});
