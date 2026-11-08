import { useId } from "react";
import { IconAlert } from "../icons";
import type { EnvironmentCardOutput } from "../nova-types";
import { ToolFrame } from "./ToolFrame";

const EFFECT_LABEL = { read: "read", write: "writes", external: "external" } as const;

/** The sandbox world built from the customer's inputs: tools (by side effect), tables, policies, warnings. */
export function EnvironmentCard({ output, index }: { output: EnvironmentCardOutput; index?: number }) {
  const id = useId();
  const writes = output.tools.filter((t) => t.effect !== "read").length;
  return (
    <ToolFrame
      title={`Sandbox world${output.source === "prebuilt" ? ", sample" : ""}`} index={index} labelledBy={id} flush
      state={output.warnings.length ? "warn" : "done"} stateLabel={output.warnings.length ? `${output.warnings.length} warning${output.warnings.length > 1 ? "s" : ""}` : "Built"}
      tone={output.warnings.length ? "warn" : "ok"}
    >
      <dl className="nv-env-stats">
        <div className="nv-env-stat"><dt className="nv-label">Tools</dt><dd className="nv-num">{output.tools.length}</dd></div>
        <div className="nv-env-stat"><dt className="nv-label">Tables</dt><dd className="nv-num">{output.tables.length}</dd></div>
        <div className="nv-env-stat"><dt className="nv-label">Policies</dt><dd className="nv-num">{output.policies.length}</dd></div>
      </dl>
      <div className="nv-tool-body">
        <div className="nv-env-section">
          <span className="nv-label">{output.name}. {writes} of {output.tools.length} tools change state</span>
          <ul className="nv-tags" aria-label="Tools">
            {output.tools.map((t) => (
              <li key={t.name} className={`nv-tag nv-effect-${t.effect}`} title={t.description || undefined}>
                <i aria-hidden="true" /><span>{t.name}</span><span className="sr-only">, {EFFECT_LABEL[t.effect]}</span>
              </li>
            ))}
          </ul>
        </div>
        {output.tables.length > 0 && (
          <div className="nv-env-section">
            <span className="nv-label">Tables</span>
            <ul className="nv-tags" aria-label="Tables">{output.tables.map((t) => <li key={t} className="nv-tag"><span>{t}</span></li>)}</ul>
          </div>
        )}
        {output.policies.length > 0 && (
          <div className="nv-env-section">
            <span className="nv-label">Policies the grader enforces</span>
            <ul className="nv-tags" aria-label="Policies">{output.policies.map((p) => <li key={p} className="nv-tag"><span>{p}</span></li>)}</ul>
          </div>
        )}
        {output.warnings.length > 0 && (
          <ul className="nv-warnings">{output.warnings.map((w) => <li key={w} className="nv-warning"><IconAlert />{w}</li>)}</ul>
        )}
      </div>
    </ToolFrame>
  );
}
