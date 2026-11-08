import { describe, expect, it } from "vitest";
import { PER_FINDING_CAP_CENTS, PER_FINDING_CENTS, perFindingCaptureCents, recognizedRevenueCents } from "./index";

describe("perFindingCaptureCents", () => {
  it("charges $25 per confirmed finding", () => {
    expect(PER_FINDING_CENTS).toBe(2500);
    expect(perFindingCaptureCents(1, 25000)).toBe(2500);
    expect(perFindingCaptureCents(4, 25000)).toBe(10000);
  });
  it("caps at the package cap", () => {
    expect(perFindingCaptureCents(20, PER_FINDING_CAP_CENTS.text_eval)).toBe(25000);
    expect(perFindingCaptureCents(50, PER_FINDING_CAP_CENTS.text_eval)).toBe(25000);
    expect(perFindingCaptureCents(50, PER_FINDING_CAP_CENTS.version_comparison)).toBe(25000);
  });
  it("is zero (release) with no confirmed findings or bad input", () => {
    expect(perFindingCaptureCents(0, 25000)).toBe(0);
    expect(perFindingCaptureCents(-1, 25000)).toBe(0);
    expect(perFindingCaptureCents(1.5, 25000)).toBe(0);
  });
});

describe("recognizedRevenueCents", () => {
  it("counts paid at amount, captured at captured amount, never the held cap", () => {
    expect(recognizedRevenueCents({ status: "paid", amountCents: 500, capturedAmountCents: null })).toBe(500);
    expect(recognizedRevenueCents({ status: "captured", amountCents: 1500, capturedAmountCents: 600 })).toBe(600);
    expect(recognizedRevenueCents({ status: "authorized", amountCents: 1500, capturedAmountCents: null })).toBe(0);
    expect(recognizedRevenueCents({ status: "released", amountCents: 1500, capturedAmountCents: 0 })).toBe(0);
  });
  it("sums a mixed ledger", () => {
    const rows = [
      { status: "paid", amountCents: 500, capturedAmountCents: null },
      { status: "captured", amountCents: 1500, capturedAmountCents: 900 },
      { status: "authorized", amountCents: 3000, capturedAmountCents: null },
      { status: "released", amountCents: 1500, capturedAmountCents: 0 },
    ];
    expect(rows.reduce((s, r) => s + recognizedRevenueCents(r), 0)).toBe(1400);
  });
});
