import type { ExplainerCard } from "@/lib/eval-chat/types";
import { RichText } from "../RichText";
import { ToolFrame } from "../ToolFrame";

export function Explainer({ data }: { data: ExplainerCard }) {
  return (
    <ToolFrame title={data.title}>
      <RichText text={data.body} className="ec-rich ec-rich-card" />
      {data.example ? <pre className="ec-pre" aria-label="Example">{data.example}</pre> : null}
    </ToolFrame>
  );
}
