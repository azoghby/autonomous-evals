import { describe, expect, it, vi } from "vitest";

const list = vi.fn();
vi.mock("./stripe", () => ({ stripe: () => ({ invoices: { list } }) }));

import type Stripe from "stripe";
import { listCustomerInvoices, toInvoiceItems } from "./invoices";

const inv = (o: Record<string, unknown>) => ({
  id: "in_1", number: "ABC-001", created: 1_800_000_000, status: "paid", amount_paid: 49900, amount_due: 0, currency: "usd",
  hosted_invoice_url: "https://invoice.stripe.com/i/x", invoice_pdf: "https://pay.stripe.com/invoice/x/pdf",
  lines: { data: [{ description: "1 x Pro (at $499.00 / month)" }] }, ...o,
}) as unknown as Stripe.Invoice;

describe("toInvoiceItems", () => {
  it("maps a paid invoice with download links", () => {
    expect(toInvoiceItems([inv({})])).toEqual([{
      id: "in_1", number: "ABC-001", created: new Date(1_800_000_000_000).toISOString(), amountCents: 49900, currency: "usd",
      status: "paid", description: "1 x Pro (at $499.00 / month)",
      hostedUrl: "https://invoice.stripe.com/i/x", pdfUrl: "https://pay.stripe.com/invoice/x/pdf",
    }]);
  });
  it("hides drafts, shows amount due on open invoices and drops non-https links", () => {
    const out = toInvoiceItems([
      inv({ id: "in_d", status: "draft" }),
      inv({ id: "in_o", status: "open", amount_paid: 0, amount_due: 1200, invoice_pdf: "javascript:alert(1)", hosted_invoice_url: null }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: "in_o", amountCents: 1200, pdfUrl: null, hostedUrl: null });
  });
});

describe("listCustomerInvoices", () => {
  it("queries Stripe by customer", async () => {
    list.mockResolvedValueOnce({ data: [inv({})] });
    expect(await listCustomerInvoices("cus_1")).toHaveLength(1);
    expect(list).toHaveBeenCalledWith({ customer: "cus_1", limit: 12 });
  });
  it("returns an empty list when Stripe fails", async () => {
    list.mockRejectedValueOnce(new Error("boom"));
    expect(await listCustomerInvoices("cus_1")).toEqual([]);
  });
});
