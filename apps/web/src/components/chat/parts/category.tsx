import { ATTACK_CATEGORIES, CATEGORY_LABELS, type ScenarioCategory } from "@/components/sandbox/contract";

const ROBUST: readonly ScenarioCategory[] = ["tool_failure", "policy_conflict"];
export const categoryGroup = (c: ScenarioCategory): "utility" | "security" | "robust" =>
  ATTACK_CATEGORIES.includes(c) ? "security" : ROBUST.includes(c) ? "robust" : "utility";

/** Category chip: colour by group (utility cyan, security violet, robustness amber). */
export function CategoryTag({ category }: { category: ScenarioCategory }) {
  return <span className="nv-tag nv-cat" data-g={categoryGroup(category)}><i aria-hidden="true" /><span>{CATEGORY_LABELS[category]}</span></span>;
}
