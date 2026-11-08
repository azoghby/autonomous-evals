/**
 * Deterministic SVG -> PNG document renderer for synthetic media attachments.
 * Every ground-truth value is visibly rendered so graders can check whether an
 * agent actually "read" it. No Date.now / Math.random: same inputs => same SVG.
 */

export type DocTemplate = "receipt" | "invoice" | "id_card" | "order_confirmation";
export interface InjectionPlacement {
  text: string;
  style: "footer_small" | "low_contrast" | "margin_rotated";
}
export interface RenderOptions {
  injection?: InjectionPlacement;
  /** Output pixel scale, default 2. */
  scale?: number;
}
export interface RenderedDocument {
  png: Uint8Array;
  svg: string;
  width: number;
  height: number;
  mediaType: "image/png";
  template: DocTemplate;
}

export type SharpFactory = (typeof import("sharp"))["default"];

/** Lazily load sharp so importing this module never fails when it is absent. */
export async function loadSharp(): Promise<SharpFactory> {
  try {
    const mod = await import("sharp");
    return mod.default;
  } catch {
    throw new Error("sharp is required for media rendering; add it to @ae/core dependencies");
  }
}

const SANS = "Helvetica, Arial, 'DejaVu Sans', sans-serif";
const MONO = "Menlo, 'DejaVu Sans Mono', 'Courier New', monospace";
const INK = "#111111";
const MUTED = "#555555";
const PAD_V = 40; // top/bottom padding (>= 4% of any page so mild crop keeps content)

// ---------------------------------------------------------------- helpers

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function labelFor(key: string): string {
  return key
    .split("_")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Greedy word wrap at a fixed character width; over-long words are hard-split. */
export function wrapText(s: string, max: number): string[] {
  const lines: string[] = [];
  let cur = "";
  for (const word of s.split(/\s+/).filter(Boolean)) {
    let w = word;
    while (w.length > max) {
      if (cur) {
        lines.push(cur);
        cur = "";
      }
      lines.push(w.slice(0, max));
      w = w.slice(max);
    }
    if (!cur) cur = w;
    else if (cur.length + 1 + w.length <= max) cur += ` ${w}`;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [""];
}

interface Page {
  readonly w: number;
  readonly padL: number;
  readonly padR: number;
  readonly bg: string;
  readonly lowFill: string;
  readonly family: string;
  readonly inj?: InjectionPlacement;
  y: number;
  out: string[];
}

interface TextOpts {
  size?: number;
  weight?: "bold" | "normal";
  fill?: string;
  anchor?: "start" | "middle" | "end";
  family?: string;
}

function newPage(
  w: number,
  inj: InjectionPlacement | undefined,
  o: Partial<Pick<Page, "padL" | "padR" | "bg" | "lowFill" | "family">> = {},
): Page {
  return {
    w,
    padL: o.padL ?? 36,
    padR: o.padR ?? 28,
    bg: o.bg ?? "#ffffff",
    lowFill: o.lowFill ?? "#f2f2f2",
    family: o.family ?? SANS,
    inj,
    y: PAD_V,
    out: [],
  };
}

function text(p: Page, x: number, y: number, s: string, o: TextOpts = {}): void {
  const attrs = [
    `x="${x}"`,
    `y="${y}"`,
    `font-family="${o.family ?? p.family}"`,
    `font-size="${o.size ?? 16}"`,
    `fill="${o.fill ?? INK}"`,
  ];
  if (o.weight === "bold") attrs.push(`font-weight="bold"`);
  if (o.anchor && o.anchor !== "start") attrs.push(`text-anchor="${o.anchor}"`);
  p.out.push(`<text ${attrs.join(" ")}>${escapeXml(s)}</text>`);
}

function rect(p: Page, x: number, y: number, w: number, h: number, fill: string, extra = ""): void {
  p.out.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" ${extra}/>`);
}

function rule(p: Page, dashed = false): void {
  const dash = dashed ? ` stroke-dasharray="6 4"` : "";
  p.out.push(
    `<line x1="${p.padL}" y1="${p.y}" x2="${p.w - p.padR}" y2="${p.y}" stroke="#999999" stroke-width="1"${dash}/>`,
  );
  p.y += 16;
}

/** Wrap rendering of a ground-truth value in a group carrying the full raw value. */
function gt(p: Page, key: string, value: string, draw: () => void): void {
  p.out.push(`<g data-gt="${escapeXml(key)}" data-value="${escapeXml(value)}">`);
  draw();
  p.out.push(`</g>`);
}

const charW = (size: number, family: string): number => size * (family === MONO ? 0.62 : 0.58);

interface RowOpts {
  size?: number;
  bold?: boolean;
  family?: string;
  labelFill?: string;
}

/** Label on the left, value right-aligned (wrapped) on the right. */
function row(p: Page, key: string, label: string, value: string, o: RowOpts = {}): void {
  const size = o.size ?? 16;
  const family = o.family ?? p.family;
  const lineH = Math.round(size * 1.45);
  const avail = p.w - p.padL - p.padR - label.length * charW(size, p.family) - 16;
  const lines = wrapText(value, Math.max(12, Math.floor(avail / charW(size, family))));
  gt(p, key, value, () => {
    text(p, p.padL, p.y, label, { size, fill: o.labelFill ?? MUTED, weight: o.bold ? "bold" : "normal" });
    lines.forEach((ln, i) =>
      text(p, p.w - p.padR, p.y + i * lineH, ln, {
        size,
        family,
        anchor: "end",
        weight: o.bold ? "bold" : "normal",
      }),
    );
  });
  p.y += lines.length * lineH + 4;
}

/** Small caption label above a left-aligned wrapped value. */
function block(p: Page, key: string, label: string, value: string, size = 17): void {
  const max = Math.floor((p.w - p.padL - p.padR) / charW(size, p.family));
  gt(p, key, value, () => {
    text(p, p.padL, p.y, label.toUpperCase(), { size: 14, fill: MUTED, weight: "bold" });
    p.y += 22;
    for (const ln of wrapText(value, max)) {
      text(p, p.padL, p.y, ln, { size });
      p.y += Math.round(size * 1.4);
    }
  });
  p.y += 8;
}

function centered(p: Page, key: string, value: string, size: number, o: TextOpts = {}): void {
  const family = o.family ?? p.family;
  const max = Math.floor((p.w - p.padL - p.padR) / charW(size, family));
  const lineH = Math.round(size * 1.4);
  gt(p, key, value, () => {
    for (const ln of wrapText(value, max)) {
      text(p, p.w / 2, p.y, ln, { ...o, size, anchor: "middle" });
      p.y += lineH;
    }
  });
}

interface LineItem {
  name: string;
  price?: string;
}

export function parseItems(items: string): LineItem[] {
  return items
    .split(/;|\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const m = /^(.*\S)\s+([$€£]?-?[\d.,]+)$/.exec(s);
      return m ? { name: m[1] as string, price: m[2] as string } : { name: s };
    });
}

function itemRows(p: Page, key: string, items: string, size = 16, family = p.family): void {
  gt(p, key, items, () => {
    const priceW = 90;
    const max = Math.floor((p.w - p.padL - p.padR - priceW) / charW(size, family));
    for (const it of parseItems(items)) {
      const lines = wrapText(it.name, max);
      lines.forEach((ln, i) => {
        text(p, p.padL, p.y + i * Math.round(size * 1.4), ln, { size, family });
      });
      if (it.price) text(p, p.w - p.padR, p.y, it.price, { size, family, anchor: "end" });
      p.y += lines.length * Math.round(size * 1.4) + 4;
    }
  });
}

function extras(p: Page, truth: Record<string, string>, used: readonly string[], size = 16): void {
  for (const [k, v] of Object.entries(truth)) {
    if (!used.includes(k)) row(p, k, `${labelFor(k)}:`, v, { size });
  }
}

/** Mid-document injection hook (low_contrast style). */
function mid(p: Page): void {
  if (p.inj?.style !== "low_contrast") return;
  const max = Math.floor((p.w - p.padL - p.padR) / charW(13, p.family));
  for (const ln of wrapText(p.inj.text, max)) {
    text(p, p.padL, p.y, ln, { size: 13, fill: p.lowFill });
    p.y += 18;
  }
  p.y += 6;
}

const pick = (truth: Record<string, string>, key: string, dflt: string): string => truth[key] ?? dflt;

// ---------------------------------------------------------------- finish

const FOOTER_LINE_H = 12;
const ROT_LINE_H = 11;
const ROT_CHARW = 5.4;

function finish(p: Page, scale: number, minH = 0, overlay: (h: number) => string[] = () => []): {
  svg: string;
  width: number;
  height: number;
} {
  const extra: string[] = [];
  let h = p.y + PAD_V;
  const inj = p.inj;
  if (inj?.style === "footer_small") {
    const lines = wrapText(inj.text, Math.floor((p.w - p.padL - p.padR) / 5));
    const startY = h - PAD_V + 12;
    lines.forEach((ln, i) =>
      extra.push(
        `<text x="${p.padL}" y="${startY + i * FOOTER_LINE_H}" font-family="${SANS}" font-size="9" fill="#888888">${escapeXml(ln)}</text>`,
      ),
    );
    h = startY + lines.length * FOOTER_LINE_H + 16;
  }
  let rotLines: string[] = [];
  if (inj?.style === "margin_rotated") {
    rotLines = wrapText(inj.text, 70);
    const longest = Math.max(...rotLines.map((l) => l.length));
    h = Math.max(h, Math.ceil(longest * ROT_CHARW) + 2 * PAD_V);
  }
  h = Math.max(Math.ceil(h), minH);
  rotLines.forEach((ln, i) => {
    const x = 14 + i * ROT_LINE_H;
    const y = Math.round((h + ln.length * ROT_CHARW) / 2);
    extra.push(
      `<text transform="rotate(-90 ${x} ${y})" x="${x}" y="${y}" font-family="${SANS}" font-size="9" fill="#777777">${escapeXml(ln)}</text>`,
    );
  });
  const width = Math.round(p.w * scale);
  const height = Math.round(h * scale);
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${p.w} ${h}">`,
    `<rect x="0" y="0" width="${p.w}" height="${h}" fill="${p.bg}"/>`,
    ...overlay(h),
    ...p.out,
    ...extra,
    `</svg>`,
  ].join("\n");
  return { svg, width, height };
}

// ---------------------------------------------------------------- templates

type Truth = Record<string, string>;
type Built = ReturnType<typeof finish>;

const RECEIPT_KEYS = ["merchant", "address", "date", "time", "items", "subtotal", "tax", "total", "payment", "receipt_number"];

function buildReceipt(t: Truth, o: RenderOptions, scale: number): Built {
  const p = newPage(400, o.injection, { family: MONO });
  centered(p, "merchant", pick(t, "merchant", "Corner Market"), 22, { weight: "bold" });
  p.y += 4;
  centered(p, "address", pick(t, "address", "100 Main St, Springfield"), 14, { fill: MUTED });
  p.y += 8;
  row(p, "date", "Date:", pick(t, "date", "2026-01-15"));
  row(p, "time", "Time:", pick(t, "time", "12:30"));
  row(p, "receipt_number", "Receipt #:", pick(t, "receipt_number", "000123"));
  rule(p, true);
  itemRows(p, "items", pick(t, "items", "Item A 5.00; Item B 7.50"), 16);
  mid(p);
  rule(p, true);
  row(p, "subtotal", "Subtotal:", pick(t, "subtotal", "12.50"));
  row(p, "tax", "Tax:", pick(t, "tax", "1.00"));
  p.y += 6;
  row(p, "total", "TOTAL", pick(t, "total", "13.50"), { size: 24, bold: true, labelFill: INK });
  p.y += 6;
  rule(p, true);
  centered(p, "payment", pick(t, "payment", "VISA ****4242"), 16);
  extras(p, t, RECEIPT_KEYS);
  p.y += 10;
  centered(p, "_thanks", "THANK YOU", 16, { weight: "bold" });
  return finish(p, scale);
}

const INVOICE_KEYS = ["vendor", "invoice_number", "invoice_date", "due_date", "bill_to", "items", "subtotal", "tax", "total", "currency"];

function buildInvoice(t: Truth, o: RenderOptions, scale: number): Built {
  const p = newPage(640, o.injection, { padL: 44, padR: 44 });
  gt(p, "vendor", pick(t, "vendor", "Northwind Supplies Ltd"), () => {
    text(p, p.padL, p.y + 10, pick(t, "vendor", "Northwind Supplies Ltd"), { size: 26, weight: "bold" });
  });
  text(p, p.w - p.padR, p.y + 10, "INVOICE", { size: 28, fill: "#777777", anchor: "end", weight: "bold" });
  p.y += 40;
  rule(p);
  row(p, "invoice_number", "Invoice #:", pick(t, "invoice_number", "INV-0001"));
  row(p, "invoice_date", "Invoice date:", pick(t, "invoice_date", "2026-01-15"));
  row(p, "due_date", "Due date:", pick(t, "due_date", "2026-02-14"));
  p.y += 10;
  block(p, "bill_to", "Bill to", pick(t, "bill_to", "Customer Co, 1 Example Way"));
  p.y += 6;
  rect(p, p.padL, p.y - 18, p.w - p.padL - p.padR, 30, "#eeeeee");
  text(p, p.padL + 8, p.y + 2, "DESCRIPTION", { size: 14, weight: "bold", fill: MUTED });
  text(p, p.w - p.padR - 8, p.y + 2, "AMOUNT", { size: 14, weight: "bold", fill: MUTED, anchor: "end" });
  p.y += 34;
  itemRows(p, "items", pick(t, "items", "Services 100.00"), 17);
  mid(p);
  rule(p);
  row(p, "subtotal", "Subtotal:", pick(t, "subtotal", "100.00"));
  row(p, "tax", "Tax:", pick(t, "tax", "0.00"));
  row(p, "total", "TOTAL DUE", pick(t, "total", "100.00"), { size: 24, bold: true, labelFill: INK });
  row(p, "currency", "Currency:", pick(t, "currency", "USD"));
  extras(p, t, INVOICE_KEYS);
  return finish(p, scale);
}

const ID_KEYS = ["full_name", "date_of_birth", "id_number", "expiry", "address", "issuer"];
const ID_CARD_INSET = 12;

function buildIdCard(t: Truth, o: RenderOptions, scale: number): Built {
  const p = newPage(640, o.injection, { padL: 214, padR: 36, bg: "#ffffff", lowFill: "#e3ecf8", family: SANS });
  const top = ID_CARD_INSET;
  p.y = top + 76;
  const field = (key: string, label: string, dflt: string, size = 20): void => {
    block(p, key, label, pick(t, key, dflt), size);
  };
  field("full_name", "Full name", "Alex Sample", 24);
  field("date_of_birth", "Date of birth", "1990-01-01");
  field("id_number", "ID number", "A1234567");
  mid(p);
  field("expiry", "Expiry", "2031-01-01");
  field("address", "Address", "1 Example Street, Springfield");
  for (const [k, v] of Object.entries(t)) {
    if (!ID_KEYS.includes(k)) field(k, labelFor(k), v);
  }
  p.y -= PAD_V - ID_CARD_INSET - 14;
  return finish(p, scale, 400, (h) => {
    const issuer = pick(t, "issuer", "State Department of Motor Vehicles");
    return [
      `<rect x="${ID_CARD_INSET}" y="${ID_CARD_INSET}" width="${p.w - 2 * ID_CARD_INSET}" height="${h - 2 * ID_CARD_INSET}" rx="18" fill="#e8f0fa" stroke="#1f3a63" stroke-width="2"/>`,
      `<path d="M${ID_CARD_INSET} ${ID_CARD_INSET + 62} V${ID_CARD_INSET + 18} a18 18 0 0 1 18 -18 H${p.w - ID_CARD_INSET - 18} a18 18 0 0 1 18 18 V${ID_CARD_INSET + 62} Z" fill="#1f3a63"/>`,
      `<g data-gt="issuer" data-value="${escapeXml(issuer)}"><text x="${ID_CARD_INSET + 24}" y="${ID_CARD_INSET + 40}" font-family="${SANS}" font-size="20" font-weight="bold" fill="#ffffff">${escapeXml(issuer)}</text></g>`,
      `<rect x="${ID_CARD_INSET + 28}" y="${ID_CARD_INSET + 92}" width="150" height="190" rx="6" fill="#c4c8cf" stroke="#8d929b"/>`,
      `<circle cx="${ID_CARD_INSET + 103}" cy="${ID_CARD_INSET + 160}" r="34" fill="#9ea3ac"/>`,
      `<path d="M${ID_CARD_INSET + 48} ${ID_CARD_INSET + 282} a55 50 0 0 1 110 0 Z" fill="#9ea3ac"/>`,
    ];
  });
}

const ORDER_KEYS = ["order_id", "email", "items", "total", "delivery_date", "shipping_address"];

function buildOrder(t: Truth, o: RenderOptions, scale: number): Built {
  const p = newPage(520, o.injection, { padL: 36, padR: 36 });
  rect(p, 0, 0, p.w, 56, "#1b2733");
  text(p, 24, 36, "ShopApp", { size: 22, weight: "bold", fill: "#ffffff" });
  text(p, p.w - 24, 36, "Orders   Account", { size: 15, fill: "#c8d1db", anchor: "end" });
  rect(p, 0, 56, p.w, 64, "#e3f6e8");
  p.out.push(`<circle cx="44" cy="88" r="14" fill="#1e9e4a"/>`);
  p.out.push(`<path d="M37 88 l5 5 l9 -10" stroke="#ffffff" stroke-width="3" fill="none"/>`);
  text(p, 70, 95, "Order confirmed", { size: 22, weight: "bold", fill: "#14632f" });
  p.y = 154;
  row(p, "order_id", "Order ID:", pick(t, "order_id", "ORD-100001"), { size: 17, bold: true, labelFill: MUTED });
  row(p, "email", "Confirmation sent to:", pick(t, "email", "customer@example.com"), { size: 17 });
  row(p, "delivery_date", "Delivery date:", pick(t, "delivery_date", "2026-01-20"), { size: 17 });
  p.y += 12;
  rect(p, p.padL - 12, p.y - 24, p.w - p.padL - p.padR + 24, 1, "#d5dae0");
  p.y += 8;
  itemRows(p, "items", pick(t, "items", "Item A 10.00"), 17);
  mid(p);
  p.y += 4;
  rect(p, p.padL - 12, p.y - 14, p.w - p.padL - p.padR + 24, 1, "#d5dae0");
  p.y += 14;
  row(p, "total", "Order total", pick(t, "total", "10.00"), { size: 22, bold: true, labelFill: INK });
  p.y += 10;
  block(p, "shipping_address", "Shipping address", pick(t, "shipping_address", "1 Example Street, Springfield"));
  extras(p, t, ORDER_KEYS, 17);
  return finish(p, scale);
}

// ---------------------------------------------------------------- public API

const BUILDERS: Record<DocTemplate, (t: Truth, o: RenderOptions, scale: number) => Built> = {
  receipt: buildReceipt,
  invoice: buildInvoice,
  id_card: buildIdCard,
  order_confirmation: buildOrder,
};

export function renderSvg(
  template: DocTemplate,
  groundTruth: Record<string, string>,
  opts: RenderOptions = {},
): { svg: string; width: number; height: number } {
  const scale = opts.scale ?? 2;
  return BUILDERS[template](groundTruth, opts, scale);
}

export async function renderDocument(
  template: DocTemplate,
  groundTruth: Record<string, string>,
  opts: RenderOptions = {},
): Promise<RenderedDocument> {
  const sharp = await loadSharp();
  const { svg, width, height } = renderSvg(template, groundTruth, opts);
  const png = await sharp(Buffer.from(svg), { density: 72 }).flatten({ background: "#ffffff" }).png().toBuffer();
  return { png: new Uint8Array(png), svg, width, height, mediaType: "image/png", template };
}
