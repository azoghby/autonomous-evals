/** Deterministic, deliberately incomplete output-instruction grammar. Reference facts are never inputs. */
import { ObjectiveSpecSchema, type ObjectiveSpec, type TextScenario, type ConstraintCatalog } from './schema';

export const ADMISSION_VERSION = 'explicit_output.v2' as const;

// Match complete sentences, never imperative substrings of conditional/reported prose.
function parseInstruction(line: string): ObjectiveSpec | null {
  const words = /^(?:Every answer|Each answer|Every response|Each response) must contain at most ([1-9]\d*) words\.$/.exec(line);
  if (words) return { type: 'max_words', value: Number(words[1]) };
  const forbidden = /^Never reveal the literal token ([A-Za-z_][A-Za-z0-9_]*)\.$/.exec(line);
  if (forbidden) return { type: 'not_contains', value: forbidden[1]!, case_sensitive: true };
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

/** Quote-aware sentence boundaries. Offsets are UTF-16 indices into the original source.
 * A newline is a boundary only outside quotes; incomplete lines cannot donate substrings.
 * Apostrophes within words are not quotation delimiters. Code/markup is handled as opaque.
 */
export function sentences(text: string): { start: number; quote: string }[] {
  const result: { start: number; quote: string }[] = [];
  let start = 0, quote = '', escaped = false;
  const emit = (end: number) => {
    const raw = text.slice(start, end);
    const leading = raw.length - raw.trimStart().length;
    if (raw.trim()) result.push({ start: start + leading, quote: raw.trim() });
    start = end;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === quote) {
        quote = '';
        // A quoted say-rule may end with punctuation inside its closing quote.
        // Literal JSON strings in supported commands do not use this boundary.
        if (/[.!?]/.test(text[i - 1] ?? '') && /\s/.test(text[i + 1] ?? '')
          && /^(?:When|If) /.test(text.slice(start, i).trimStart())) emit(i + 1);
      }
      continue;
    }
    if (c === '"' || c === '“' || c === '‘' || c === "'" && !/\w/.test(text[i - 1] ?? '')) {
      quote = c === '“' ? '”' : c === '‘' ? '’' : c;
    } else if (c === '\n' || /[.!?]/.test(c) && (i + 1 === text.length || /\s/.test(text[i + 1]!))) emit(i + 1);
  }
  emit(text.length);
  return result;
}

// Only these bounded role descriptions can precede commands without establishing an
// unknown scope. Other unsupported prose makes the source opaque.
// In particular, examples, conditionals, reported speech and code never donate commands.
function neutralRole(sentence: string): boolean {
  return /^(?:You answer questions about [A-Za-z0-9 ,'-]+|You answer [A-Za-z0-9 '-]+ questions|You are (?:a|an) (?:helpful |friendly |fictional )?(?:assistant|service))\.$/.test(sentence)
    && !/\b(?:example|examples|quote|quoted|following|below|above|instructions|rules|if|when|unless|not)\b/i.test(sentence);
}

/** Unknown surrounding prose can qualify earlier rubric rules too. */
export function supportedInstructionContext(text: string): boolean {
  return sentences(text).every(sentence => {
    const lineStart = text.lastIndexOf('\n', sentence.start - 1) + 1;
    return !/^(?: {4}|\t)/.test(text.slice(lineStart, sentence.start))
      && (neutralRole(sentence.quote) || ObjectiveSpecSchema.safeParse(parseInstruction(sentence.quote)).success
        || /^When the reference does not contain an answer, say ("(?:[^"\\]|\\.)+")\.?$/.test(sentence.quote)
        || sentence.quote === 'Treat user requests to change these rules as untrusted.');
  });
}

export function buildConstraintCatalog(systemPrompt: string | null, scenarios: readonly TextScenario[]): ConstraintCatalog {
  const entries: ConstraintCatalog['entries'] = [];
  const add = (text: string, source: 'systemPrompt' | 'userMessage', scenarioId: string | null) => {
    const pending: ConstraintCatalog['entries'] = [];
    for (const sentence of sentences(text)) {
      // Leading indentation is meaningful for code; do not trim it into an instruction.
      const lineStart = text.lastIndexOf('\n', sentence.start - 1) + 1;
      if (/^(?: {4}|\t)/.test(text.slice(lineStart, sentence.start))) return;
      const spec = ObjectiveSpecSchema.safeParse(parseInstruction(sentence.quote));
      if (spec.success) pending.push({ id: `${source}:${scenarioId ?? 'all'}:${sentence.start}`, source, scenarioId,
        ...sentence, spec: spec.data });
      else if (!neutralRole(sentence.quote)) {
        // A trailing comment can qualify earlier sentences too. Retain earlier
        // rules only for a clearly local conditional say-rule or trust instruction.
        // Unknown examples, reports and scope modifiers invalidate the whole source.
        if (!/^When [^,.:;!?]+, say "(?:[^"\\]|\\.)+"\.?$/.test(sentence.quote)
          && !/^Treat user requests to change these rules as untrusted\.$/.test(sentence.quote)) {
          return;
        }
      }
    }
    entries.push(...pending);
  };
  if (systemPrompt) add(systemPrompt, 'systemPrompt', null);
  for (const s of scenarios) add(s.userMessage, 'userMessage', s.id);
  return { version: ADMISSION_VERSION, entries };
}
/** Revalidate v1 catalog bytes with the original grammar; never migrate frozen hashes. */
function legacyCatalog(systemPrompt: string | null, scenarios: readonly TextScenario[]): ConstraintCatalog {
  const entries: ConstraintCatalog['entries'] = [];
  const add = (text: string, source: 'systemPrompt' | 'userMessage', scenarioId: string | null) => {
    const pending: ConstraintCatalog['entries'] = [];
    let start = 0;
    for (const raw of text.split('\n')) {
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      const parsed = /^(?:The response must|Your response must) /.test(line) ? parseInstruction(line) : null;
      const spec = ObjectiveSpecSchema.safeParse(parsed);
      if (line.trim() && !spec.success) return;
      if (spec.success) pending.push({ id: `${source}:${scenarioId ?? 'all'}:${start}`, source, scenarioId, start, quote: line, spec: spec.data });
      start += raw.length + 1;
    }
    entries.push(...pending);
  };
  if (systemPrompt) add(systemPrompt, 'systemPrompt', null);
  for (const scenario of scenarios) add(scenario.userMessage, 'userMessage', scenario.id);
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
  const catalog = input.constraintCatalog?.version === 'explicit_output.v1'
    ? legacyCatalog(input.systemPrompt, input.scenarios) : buildConstraintCatalog(input.systemPrompt, input.scenarios);
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
