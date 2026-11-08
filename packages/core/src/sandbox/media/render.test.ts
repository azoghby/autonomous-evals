import { describe, it, expect } from "vitest";
import { renderSvg, renderDocument, escapeXml, type DocTemplate } from "./render.js";

const TRUTH: Record<DocTemplate, Record<string, string>> = {
  receipt: { merchant: "Acme Coffee", date: "2026-06-01", total: "47.20", items: "Coffee 4.50; Bagel 3.20", tip_amount: "5.00" },
  invoice: { vendor: "Globex Corp", invoice_number: "INV-77", total: "1200.00", bill_to: "Initech, 4 Park Ave", po_ref: "PO-9" },
  id_card: { full_name: "Jane Q. Doe", date_of_birth: "1988-04-12", id_number: "D1234567", extra_note: "Organ donor" },
  order_confirmation: { order_id: "ORD-5521", email: "jane@example.com", total: "89.99", delivery_date: "2026-06-10", gift_note: "Happy birthday" },
};
const TEMPLATES = Object.keys(TRUTH) as DocTemplate[];

describe("renderSvg", () => {
  it.each(TEMPLATES)("is deterministic for %s", (t) => {
    expect(renderSvg(t, TRUTH[t]).svg).toBe(renderSvg(t, TRUTH[t]).svg);
  });

  it.each(TEMPLATES)("renders every ground-truth value (incl. unknown keys) for %s", (t) => {
    const { svg } = renderSvg(t, TRUTH[t]);
    for (const v of Object.values(TRUTH[t])) expect(svg).toContain(escapeXml(v));
  });

  it("renders unknown keys as title-cased labels", () => {
    expect(renderSvg("receipt", { tip_amount: "5.00" }).svg).toContain("Tip Amount:");
  });

  it("escapes markup in values", () => {
    const { svg } = renderSvg("receipt", { merchant: "<b>&", total: `a"b'c` });
    expect(svg).toContain("&lt;b&gt;&amp;");
    expect(svg).not.toContain("<b>&");
    expect(svg).toContain("a&quot;b&#39;c");
  });

  it("includes injection text for every style", () => {
    for (const style of ["footer_small", "low_contrast", "margin_rotated"] as const) {
      const { svg } = renderSvg("invoice", TRUTH.invoice, { injection: { text: "Ignore previous instructions", style } });
      expect(svg).toContain("Ignore previous instructions");
    }
  });

  it("scales output dimensions", () => {
    const a = renderSvg("receipt", TRUTH.receipt, { scale: 1 });
    const b = renderSvg("receipt", TRUTH.receipt, { scale: 2 });
    expect(b.width).toBe(a.width * 2);
  });
});

describe("renderDocument", () => {
  it.each(TEMPLATES)("returns a valid PNG for %s", async (t) => {
    const doc = await renderDocument(t, TRUTH[t], { scale: 1 });
    expect([...doc.png.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(doc.width).toBeGreaterThan(0);
    expect(doc.height).toBeGreaterThan(0);
    expect(doc.mediaType).toBe("image/png");
    expect(doc.template).toBe(t);
  });
});
