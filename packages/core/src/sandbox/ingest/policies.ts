import { PolicyDoc } from "../spec";

const MAX_TEXT = 2_000;
const MAX_ID = 63;
const FALLBACK_TITLE = "Policy";

const RE_H1 = /^#\s+(.+?)\s*#*\s*$/;
const RE_HEADING = /^#{2,6}\s+(.+?)\s*#*\s*$/;
const RE_HEADING_NUM = /^(\d+)[.)]?(?:\s+|$)/;
const RE_CLAUSE = /^(\d+)\.(\d+)[.)]?\s+(\S.*)$/;
const RE_NUM_ITEM = /^(\d+)[.)]\s+(\S.*)$/;
const RE_BULLET = /^[-*+]\s+(\S.*)$/;

interface Draft { id: string; parts: string[] }

function slugify(title: string): string {
  const base = title.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const prefixed = /^[a-z]/.test(base) ? base : base ? `p_${base}` : "policy";
  return prefixed.slice(0, MAX_ID).replace(/_+$/, "") || "policy";
}

function suffixFor(n: number): string {
  // 1 -> b, 2 -> c, ... beyond z continues aa, ab
  let out = "";
  let i = n;
  do {
    out = String.fromCharCode(97 + (i % 26)) + out;
    i = Math.floor(i / 26) - 1;
  } while (i >= 0);
  return out;
}

function isNumberedDoc(lines: string[]): boolean {
  return lines.some((l) => RE_CLAUSE.test(l.trim()) || (RE_HEADING.test(l) && RE_HEADING_NUM.test(l.replace(/^#+\s+/, ""))));
}

/** Parse a markdown policy document into stable, addressable clauses. */
export function parsePolicies(markdown: string, opts: { id?: string; title?: string } = {}): PolicyDoc {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const numberedDoc = isNumberedDoc(lines);

  let docTitle: string | undefined;
  let section: number | null = null;
  let headingIndex = 0;
  let sectionCounter = 0;
  let topCounter = 0;
  let sawBlank = false;
  let current: Draft | null = null;
  const drafts: Draft[] = [];

  const start = (id: string, text: string): void => {
    current = { id, parts: [text] };
    drafts.push(current);
  };

  for (const raw of lines) {
    const line = raw.replace(/\t/g, "    ");
    const trimmed = line.trim();
    if (trimmed === "") { sawBlank = true; continue; }
    const indented = /^\s+/.test(line);
    const blankBefore = sawBlank;
    sawBlank = false;

    if (!indented) {
      const h1 = RE_H1.exec(trimmed);
      if (h1) { docTitle ??= h1[1]; current = null; continue; }
      const h = RE_HEADING.exec(trimmed);
      if (h) {
        headingIndex += 1;
        const num = RE_HEADING_NUM.exec(h[1]);
        section = num ? Number(num[1]) : headingIndex;
        sectionCounter = 0;
        current = null;
        continue;
      }
      const cl = RE_CLAUSE.exec(trimmed);
      if (cl) { start(`P${cl[1]}.${cl[2]}`, cl[3]); continue; }
      const item = RE_NUM_ITEM.exec(trimmed);
      if (item) {
        start(section !== null ? `P${section}.${item[1]}` : `P${item[1]}`, item[2]);
        continue;
      }
      const bullet = RE_BULLET.exec(trimmed);
      if (bullet) {
        if (section !== null) { sectionCounter += 1; start(`P${section}.${sectionCounter}`, bullet[1]); }
        else { topCounter += 1; start(`P${topCounter}`, bullet[1]); }
        continue;
      }
    }

    // Continuation: indented text, or text directly following a clause line.
    if (current && (indented || !blankBefore)) {
      (current as Draft).parts.push(trimmed);
      continue;
    }
    // Free paragraph: only a clause in documents with no numbering at all.
    if (!numberedDoc) {
      if (section !== null) { sectionCounter += 1; start(`P${section}.${sectionCounter}`, trimmed); }
      else { topCounter += 1; start(`P${topCounter}`, trimmed); }
    }
  }

  if (drafts.length === 0) {
    throw new Error("parsePolicies: no policy clauses found (expected numbered clauses like '2.1 Text', numbered lists, bullets, or paragraphs)");
  }

  const seen = new Map<string, number>();
  const clauses = drafts.map((d) => {
    const n = seen.get(d.id) ?? 0;
    seen.set(d.id, n + 1);
    const id = n === 0 ? d.id : `${d.id}-${suffixFor(n)}`;
    return { id, text: d.parts.join(" ").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT) };
  });

  const title = (opts.title ?? docTitle ?? FALLBACK_TITLE).trim() || FALLBACK_TITLE;
  return PolicyDoc.parse({ id: opts.id ?? slugify(title), title, clauses });
}

export function loadClauseIds(doc: PolicyDoc): string[] {
  return doc.clauses.map((c) => c.id);
}
