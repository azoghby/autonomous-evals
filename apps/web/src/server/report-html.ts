/**
 * Minimal, safe markdown -> HTML renderer for the report page. Every character of input is
 * HTML-escaped before any markup is added; raw HTML and links are never passed through.
 */
const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ESC[c]!);

function inline(raw: string): string {
  return escapeHtml(raw)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

export function renderMarkdownToHtml(md: string): string {
  const out: string[] = [];
  let para: string[] = [];
  let list: string[] = [];
  let code: string[] | null = null;
  const flushPara = () => { if (para.length) out.push(`<p>${inline(para.join(" "))}</p>`); para = []; };
  const flushList = () => { if (list.length) out.push(`<ul>${list.map((l) => `<li>${inline(l)}</li>`).join("")}</ul>`); list = []; };
  for (const line of md.replace(/\r\n?/g, "\n").split("\n")) {
    if (code) {
      if (line.startsWith("```")) { out.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`); code = null; } else code.push(line);
      continue;
    }
    if (line.startsWith("```")) { flushPara(); flushList(); code = []; continue; }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { flushPara(); flushList(); out.push(`<h${h[1]!.length}>${inline(h[2]!)}</h${h[1]!.length}>`); continue; }
    const li = /^\s*[-*]\s+(.*)$/.exec(line);
    if (li) { flushPara(); list.push(li[1]!); continue; }
    if (!line.trim()) { flushPara(); flushList(); continue; }
    flushList(); para.push(line.trim());
  }
  if (code) out.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
  flushPara(); flushList();
  return out.join("\n");
}

export function renderReportDocument(title: string, md: string): string {
  const css = "body{font:16px/1.6 system-ui,sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem;color:#111}pre{background:#f4f4f5;padding:.75rem;overflow:auto}code{font-family:ui-monospace,monospace}";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${css}</style></head><body>${renderMarkdownToHtml(md)}</body></html>`;
}
