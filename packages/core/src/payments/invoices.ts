import type Stripe from "stripe";
import { stripe } from "./stripe";

export interface InvoiceListItem {
  id: string;
  number: string | null;
  /** ISO timestamp of invoice creation. */
  created: string;
  amountCents: number;
  currency: string;
  /** Stripe invoice status: paid | open | void | uncollectible (drafts are excluded). */
  status: string;
  description: string | null;
  hostedUrl: string | null;
  pdfUrl: string | null;
}

const isHttps = (u: string | null | undefined): u is string => !!u && u.startsWith("https://");

/** Maps Stripe invoices to the billing-history rows. Drafts are hidden; only https Stripe URLs are passed through. */
export function toInvoiceItems(invoices: readonly Stripe.Invoice[]): InvoiceListItem[] {
  return invoices
    .filter((i) => i.status && i.status !== "draft")
    .map((i) => ({
      id: i.id ?? "",
      number: i.number ?? null,
      created: new Date(i.created * 1000).toISOString(),
      amountCents: i.status === "paid" ? i.amount_paid : i.amount_due,
      currency: i.currency,
      status: i.status ?? "open",
      description: i.lines?.data?.[0]?.description ?? null,
      hostedUrl: isHttps(i.hosted_invoice_url) ? i.hosted_invoice_url : null,
      pdfUrl: isHttps(i.invoice_pdf) ? i.invoice_pdf : null,
    }))
    .filter((i) => i.id);
}

/** Latest invoices for a Stripe customer (test or live per STRIPE_MODE). Returns [] on Stripe errors. */
export async function listCustomerInvoices(stripeCustomerId: string, limit = 12): Promise<InvoiceListItem[]> {
  try {
    const res = await stripe().invoices.list({ customer: stripeCustomerId, limit });
    return toInvoiceItems(res.data);
  } catch (err) {
    console.error("invoice list failed", err instanceof Error ? err.message : err);
    return [];
  }
}
