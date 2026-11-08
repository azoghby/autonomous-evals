"use client";
import { useEffect, useRef, useState } from "react";
import { useInView } from "motion/react";

type Seg = { t: string; c: string };
type Row = { segs: Seg[] };

const C = { fg: "text-fg", mut: "text-subtle", acc: "text-accent-text", ok: "text-ok", str: "text-warn", dim: "text-fg-2" };

export type McpProps = { quote: string; command: string };

function buildRows(quote: string, command: string): { cmd: Seg[]; rows: Row[] } {
  const [head, ...rest] = command.split(" --");
  const cmd: Seg[] = [{ t: "claude ", c: C.fg }, { t: head.replace("claude ", ""), c: C.acc }];
  for (const r of rest) {
    const [flag, ...vals] = r.split(" ");
    const v = vals.join(" ");
    cmd.push({ t: ` --${flag}`, c: C.mut });
    const url = v.match(/https?:\/\/\S+/)?.[0];
    if (url) { cmd.push({ t: ` ${v.replace(url, "").trim()} `, c: C.dim }, { t: url, c: C.str }); }
    else cmd.push({ t: ` ${v}`, c: C.str });
  }
  const call = (name: string): Seg[] => [{ t: "→ ", c: C.acc }, { t: name, c: C.fg }];
  const rows: Row[] = [
    { segs: [{ t: "✓ Added HTTP MCP server autonomous-evals", c: C.ok }] },
    { segs: [{ t: "", c: "" }] },
    { segs: [{ t: "> ", c: C.mut }, { t: "Audit my support agent at api.acme.dev", c: C.dim }] },
    { segs: [...call("hire_audit"), { t: '({ package: "trace_audit" })', c: C.mut }] },
    { segs: [...call("quote"), { t: ` ${quote}, fixed, no contract`, c: C.dim }] },
    { segs: [...call("pay"), { t: " settled by key", c: C.dim }, { t: "  ✓", c: C.ok }] },
    { segs: [...call("report"), { t: " https://autonomous-evals.vercel.app/r/…", c: C.str }] },
  ];
  return { cmd, rows };
}

function Segs({ segs, n }: { segs: Seg[]; n: number }) {
  let off = 0;
  return (
    <>
      {segs.map((s, i) => {
        const vis = Math.max(0, Math.min(s.t.length, n - off));
        off += s.t.length;
        return (
          <span key={i} className={s.c}>
            {s.t.slice(0, vis)}
            <span className="opacity-0">{s.t.slice(vis)}</span>
          </span>
        );
      })}
    </>
  );
}

export function McpTerminal({ quote, command }: McpProps) {
  const { cmd, rows } = buildRows(quote, command);
  const total = cmd.reduce((a, s) => a + s.t.length, 0);
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: "-60px" });
  const [armed, setArmed] = useState(false);
  const [chars, setChars] = useState(total);
  const [lines, setLines] = useState(rows.length);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const r = ref.current?.getBoundingClientRect();
    if (r && r.top < window.innerHeight * 0.6) return; // visible at mount: show static
    setArmed(true); setChars(0); setLines(0);
  }, []);

  useEffect(() => {
    if (!armed || !inView) return;
    let c = 0, l = 0;
    const id = setInterval(() => {
      if (c < total) { c = Math.min(total, c + 3); setChars(c); }
      else if (l < rows.length) { l += 1; setLines(l); }
      else clearInterval(id);
    }, 40);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [armed, inView, total]);

  const done = chars >= total && lines >= rows.length;
  const onCopy = async () => {
    try { await navigator.clipboard.writeText(command); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch { /* unavailable */ }
  };

  return (
    <div ref={ref} className="relative isolate">
      <span aria-hidden className="mcp-glow" />
      <div className="min-w-0 max-w-full overflow-hidden rounded-[4px] border border-line-2 bg-bg-raised">
        <div className="flex h-10 items-center justify-between gap-3 border-b border-line px-3">
          <span className="flex items-center gap-3">
            <span aria-hidden className="flex gap-1.5"><i className="size-2 rounded-full bg-line-3" /><i className="size-2 rounded-full bg-line-3" /><i className="size-2 rounded-full bg-line-3" /></span>
            <span className="font-mono text-[11px] uppercase text-subtle">Add the MCP server</span>
          </span>
          <button type="button" onClick={onCopy} className="inline-flex h-7 items-center rounded-[4px] px-2 font-mono text-[11px] uppercase text-fg-2 transition-colors duration-150 hover:bg-bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-accent">
            <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
          </button>
        </div>
        <div className="p-4 font-mono text-[13px] leading-[1.7]">
          <span className="sr-only">{command}</span>
          <div aria-hidden className="whitespace-pre-wrap break-all">
            <span className="mr-2 select-none text-subtle">$</span>
            <Segs segs={cmd} n={chars} />
            {!done && chars < total && <span className="mcp-cursor" />}
          </div>
          <div aria-hidden className="mt-1">
            {rows.map((r, i) => (
              <div key={i} className="mcp-line whitespace-pre-wrap break-words" style={{ opacity: i < lines ? 1 : 0, transform: i < lines ? "none" : "translateY(4px)" }}>
                <Segs segs={r.segs} n={9999} />{r.segs[0].t === "" ? " " : ""}
              </div>
            ))}
            <div className="mt-1"><span className="mr-2 select-none text-subtle">$</span><span className="mcp-cursor" /></div>
          </div>
        </div>
      </div>
    </div>
  );
}
