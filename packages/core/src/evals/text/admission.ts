/** Deterministic, deliberately incomplete output-instruction grammar. Reference facts are never inputs. */
import { ObjectiveSpecSchema, type ObjectiveSpec, type TextScenario, type ConstraintCatalog } from './schema';

// Full-line matching matters: extracting an imperative substring from a conditional,
// quotation, reference fact, or negated instruction would invent an unconditional rule.
function parseInstruction(line: string): ObjectiveSpec | null {
  let m = /^(?:The response must|Your response must) (contain|not contain) the literal ("(?:[^"\\]|\\.)+")( case-insensitive)?\.$/.exec(line);
  if (m) {
    try { return { type: m[1] === 'contain' ? 'contains' : 'not_contains', value: JSON.parse(m[2]!), case_sensitive: !m[3] }; } catch { return null; }
  }
  m = /^(?:The response must|Your response must) contain at least one of these literals: (\[.*\])( case-insensitive)?\.$/.exec(line);
  if (m) { try { return { type: 'contains_any', values: JSON.parse(m[1]!), case_sensitive: !m[2] }; } catch { return null; } }
  m = /^(?:The response must|Your response must) (have at most|have at least) ([1-9]\d*) (characters|words|lines)\.$/.exec(line);
  if (m) {
    const type = m[1] === 'have at least' ? (m[3] === 'characters' ? 'min_chars' : null)
      : m[3] === 'characters' ? 'max_chars' : m[3] === 'words' ? 'max_words' : 'max_lines';
    return type ? { type, value: Number(m[2]) } : null;
  }
  if (/^(?:The response must|Your response must) be valid JSON\.$/.test(line)) return { type: 'json_valid' };
  m = /^(?:The response must|Your response must) be a JSON object with these required keys: (\[.*\])\.$/.exec(line);
  if (m) { try { return { type: 'json_has_keys', keys: JSON.parse(m[1]!) }; } catch { return null; } }
  return null;
}

export function buildConstraintCatalog(systemPrompt: string | null, scenarios: readonly TextScenario[]): ConstraintCatalog {
  const entries: ConstraintCatalog['entries'] = [];
  const add = (text: string, source: 'systemPrompt' | 'userMessage', scenarioId: string | null) => {
    let start = 0;
    const pending: ConstraintCatalog['entries'] = [];
    for (const raw of text.split('\n')) {
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      const spec = ObjectiveSpecSchema.safeParse(parseInstruction(line));
      if (line.trim() && !spec.success) return; // Mixed prose/quoted/conditional contexts are not machine-admissible.
      if (spec.success) pending.push({ id: `${source}:${scenarioId ?? 'all'}:${start}`, source, scenarioId, start, quote: line, spec: spec.data });
      start += raw.length + 1;
    }
    entries.push(...pending);
  };
  if (systemPrompt) add(systemPrompt, 'systemPrompt', null);
  for (const s of scenarios) add(s.userMessage, 'userMessage', s.id);
  return { version: 'explicit_output.v1', entries };
}
const same = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const x = Object.keys(a).sort(), y = Object.keys(b).sort();
  return JSON.stringify(x) === JSON.stringify(y) && x.every(k => same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
};

/** No implication guessing: even relaxed bounds/case changes need an exact catalog spec. */
export function objectiveAdmissionProblems(input: { systemPrompt: string | null; scenarios: readonly TextScenario[]; constraintCatalog?: ConstraintCatalog }): string[] {
  const catalog = buildConstraintCatalog(input.systemPrompt, input.scenarios);
  const problems: string[] = [];
  if (input.constraintCatalog && !same(input.constraintCatalog, catalog)) problems.push('constraint catalog provenance does not match authoritative output instructions');
  for (const scenario of input.scenarios) for (const check of scenario.objectiveChecks) {
    const matches = catalog.entries.filter(e => (e.scenarioId === null || e.scenarioId === scenario.id) && same(e.spec, check.spec));
    if (!matches.length || input.constraintCatalog !== undefined && check.constraintId === undefined || check.constraintId !== undefined && !matches.some(e => e.id === check.constraintId)) {
      problems.push(`${check.id}: objective lacks a matching explicit output constraint; use a rubric for factual meaning or unsupported language`);
    }
  }
  return problems;
}

/** Bind code-derived provenance, never agent-supplied quotes. Call only after admission. */
export function bindObjectiveConstraints(systemPrompt: string | null, scenarios: readonly TextScenario[]) {
  const constraintCatalog = buildConstraintCatalog(systemPrompt, scenarios);
  return { constraintCatalog, scenarios: scenarios.map(s => ({ ...s, objectiveChecks: s.objectiveChecks.map(c => ({ ...c,
    constraintId: constraintCatalog.entries.find(e => (e.scenarioId === null || e.scenarioId === s.id) && same(e.spec, c.spec))!.id,
  })) })) };
}
