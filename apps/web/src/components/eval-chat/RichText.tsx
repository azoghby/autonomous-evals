import { parseInline, splitParagraphs } from "./format";

/** Plain-text paragraphs with **bold** and `code` only. Everything is a React text node: no HTML is ever injected. */
export function RichText({ text, className }: { text: string; className?: string }) {
  return (
    <div className={className ?? "ec-rich"}>
      {splitParagraphs(text).map((p, i) => (
        <p key={i}>
          {parseInline(p).map((run, j) =>
            run.type === "bold" ? <strong key={j}>{run.value}</strong> : run.type === "code" ? <code key={j} className="ec-inline-code">{run.value}</code> : run.value,
          )}
        </p>
      ))}
    </div>
  );
}
