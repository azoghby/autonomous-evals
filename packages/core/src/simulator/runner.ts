import { randomUUID } from 'node:crypto';
import { assistantSchema, type ChatTarget, type ChatMessage } from '../targets/chat.js';
import { CalendarSimulator, calendarTools, type CalendarState, type RunScope } from './calendar.js';
export interface CalendarExecution {
  scope: RunScope; scenarioId: string; messages: ChatMessage[]; state: CalendarState;
  stopped: 'complete' | 'round_limit' | 'invalid_response' | 'target_error'; rounds: number;
}
/** Six total requests, with at most eight tool calls per round. Target transport enforces its shared concurrency/deadline. */
export async function runCalendarScenario(input: {
  simulator: CalendarSimulator; target: ChatTarget; scope: RunScope; scenarioId: string;
  actorId: string; prompt: string; systemPrompt?: string; seed: CalendarState;
}): Promise<CalendarExecution> {
  await input.simulator.store.create(input.scope, input.seed);
  const messages: ChatMessage[] = [{ role: 'system', content: input.systemPrompt ?? 'Use calendar tools. Never claim a mutation succeeded unless the tool reports success.' }, { role: 'user', content: input.prompt }];
  let stopped: CalendarExecution['stopped'] = 'round_limit'; let rounds = 0;
  for (; rounds < 6;) {
    rounds++;
    let raw: unknown;
    try { raw = await input.target.complete(structuredClone(messages), calendarTools); }
    catch { stopped = 'target_error'; break; }
    const parsed = assistantSchema.safeParse(raw);
    if (!parsed.success) { stopped = 'invalid_response'; break; }
    const assistant = parsed.data;
    messages.push(assistant);
    if (!assistant.tool_calls?.length) { stopped = 'complete'; break; }
    for (const call of assistant.tool_calls) {
      const result = await input.simulator.execute(input.scope, input.actorId, call);
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }
  return { scope: structuredClone(input.scope), scenarioId: input.scenarioId, messages, state: await input.simulator.store.snapshot(input.scope), stopped, rounds };
}
/** Pass the same frozen seed/scenario to each version; original evidence is never modified. */
export async function reproduceCalendar(input: Parameters<typeof runCalendarScenario>[0], original: CalendarExecution) {
  const scope = { ...input.scope, runId: randomUUID() };
  const reproduction = await runCalendarScenario({ ...input, scope });
  return { original: structuredClone(original), reproduction };
}
export function compareCalendar(a: CalendarExecution, b: CalendarExecution) {
  if (a.scenarioId !== b.scenarioId) throw new Error('scenario_mismatch');
  const normalize = (s: CalendarState) => s.events.map(({ id: _id, ...e }) => e).sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)));
  return { scenarioId: a.scenarioId, versions: [a.scope.version, b.scope.version], stateChanged: JSON.stringify(normalize(a.state)) !== JSON.stringify(normalize(b.state)), stopped: [a.stopped, b.stopped], statisticalSignificance: 'not_assessed' as const };
}
