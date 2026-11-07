import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FunctionTool, ToolCall } from '../targets/chat.js';

export interface RunScope { jobId: string; runId: string; version: string }
export interface Calendar { id: string; ownerId: string }
export interface Permission { calendarId: string; actorId: string; access: 'read' | 'write' }
export interface CalendarEvent {
  id: string; calendarId: string; ownerId: string; title: string;
  startUtc: string; endUtc: string; timeZone: string; status: 'active' | 'cancelled';
}
export interface ToolResult { ok: boolean; code: string; events?: CalendarEvent[]; event?: CalendarEvent }
export interface ToolRecord { id: string; actorId: string; name: string; arguments: string; result: ToolResult }
export interface CalendarState {
  calendars: Calendar[]; permissions: Permission[]; events: CalendarEvent[]; calls: ToolRecord[];
  failNextMutation: boolean;
}
export interface CalendarStore {
  /** Must fail if this scope already exists. Never reuse a run/version for reproduction. */
  create(scope: RunScope, seed: CalendarState): Promise<void>;
  /** Callback and all writes are atomic, serialized per scope; rollback on throw. */
  transact<T>(scope: RunScope, action: (state: CalendarState) => T): Promise<T>;
  snapshot(scope: RunScope): Promise<CalendarState>;
  reset(scope: RunScope): Promise<void>;
}
export function scopeKey(scope: RunScope): string {
  for (const part of [scope.jobId, scope.runId, scope.version]) if (!part || part.length > 128) throw new Error('invalid_scope');
  return JSON.stringify([scope.jobId, scope.runId, scope.version]);
}
export class MemoryCalendarStore implements CalendarStore {
  private states = new Map<string, CalendarState>();
  async create(scope: RunScope, seed: CalendarState) {
    const key = scopeKey(scope); if (this.states.has(key)) throw new Error('run_exists');
    this.states.set(key, structuredClone(seed));
  }
  async transact<T>(scope: RunScope, action: (state: CalendarState) => T): Promise<T> {
    const key = scopeKey(scope); const previous = this.states.get(key); if (!previous) throw new Error('run_missing');
    const next = structuredClone(previous); const result = action(next); this.states.set(key, next); return structuredClone(result);
  }
  async snapshot(scope: RunScope) {
    const state = this.states.get(scopeKey(scope)); if (!state) throw new Error('run_missing'); return structuredClone(state);
  }
  async reset(scope: RunScope) { this.states.delete(scopeKey(scope)); }
}
const id = z.string().min(1).max(128);
const instant = z.string().datetime({ offset: false }).transform(s => new Date(s).toISOString());
const zone = z.string().max(100).refine(s => {
  try { new Intl.DateTimeFormat('en', { timeZone: s }); return s === 'UTC' || s.includes('/'); } catch { return false; }
});
const eventFields = { title: z.string().min(1).max(200), startUtc: instant, endUtc: instant, timeZone: zone };
const schemas = {
  list_events: z.object({ calendarId: id }).strict(),
  create_event: z.object({ calendarId: id, ...eventFields }).strict(),
  update_event: z.object({ eventId: id, ...eventFields }).strict(),
  cancel_event: z.object({ eventId: id }).strict(),
};
export type CalendarToolName = keyof typeof schemas;
const eventProperties = {
  title: { type: 'string', minLength: 1, maxLength: 200 },
  startUtc: { type: 'string', description: 'UTC ISO 8601 instant ending in Z; convert local time before calling.' },
  endUtc: { type: 'string', description: 'UTC ISO 8601 instant ending in Z.' },
  timeZone: { type: 'string', description: 'Explicit IANA zone, e.g. America/Los_Angeles or UTC.' },
};
export const calendarTools: FunctionTool[] = (Object.keys(schemas) as CalendarToolName[]).map(name => {
  const properties = name === 'list_events' ? { calendarId: { type: 'string' } }
    : name === 'cancel_event' ? { eventId: { type: 'string' } }
    : { ...(name === 'create_event' ? { calendarId: { type: 'string' } } : { eventId: { type: 'string' } }), ...eventProperties };
  return { type: 'function', function: { name, description: `Calendar simulator: ${name}. Mutations can fail; inspect ok and code.`,
    parameters: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false } } };
});
export class CalendarSimulator {
  constructor(readonly store: CalendarStore) {}
  async execute(scope: RunScope, actorId: string, call: ToolCall): Promise<ToolResult> {
    if (!actorId || actorId.length > 128 || !call.id || call.id.length > 128 || call.function.arguments.length > 32_000) return { ok: false, code: 'invalid_arguments' };
    return this.store.transact(scope, state => {
      const previous = state.calls.find(c => c.id === call.id);
      if (previous) return previous.actorId === actorId && previous.name === call.function.name && previous.arguments === call.function.arguments
        ? previous.result : { ok: false, code: 'idempotency_conflict' };
      const result = this.apply(state, actorId, call);
      state.calls.push({ id: call.id, actorId, name: call.function.name, arguments: call.function.arguments, result: structuredClone(result) });
      return result;
    });
  }
  private apply(state: CalendarState, actor: string, call: ToolCall): ToolResult {
    const name = call.function.name as CalendarToolName;
    if (!Object.hasOwn(schemas, name)) return { ok: false, code: 'unknown_tool' };
    let args: unknown;
    try { args = JSON.parse(call.function.arguments); } catch { return { ok: false, code: 'invalid_arguments' }; }
    const parsed = schemas[name].safeParse(args);
    if (!parsed.success) return { ok: false, code: 'invalid_arguments' };
    const a = parsed.data;
    const timing = z.object(eventFields).safeParse(a);
    const fields = timing.success ? timing.data : undefined;
    const event = 'eventId' in a ? state.events.find(e => e.id === a.eventId) : undefined;
    const calendarId = 'calendarId' in a ? a.calendarId : event?.calendarId;
    const calendar = state.calendars.find(c => c.id === calendarId);
    const access = calendar?.ownerId === actor ? 'write' : state.permissions.find(p => p.calendarId === calendarId && p.actorId === actor)?.access;
    // Missing and inaccessible objects intentionally have the same response.
    if (!calendar || !access || (name !== 'list_events' && access !== 'write')) return { ok: false, code: 'forbidden' };
    if (name === 'list_events') return { ok: true, code: 'listed', events: state.events.filter(e => e.calendarId === calendarId).map(e => ({ ...e })) };
    if (fields && fields.startUtc >= fields.endUtc) return { ok: false, code: 'invalid_interval' };
    if (event?.status === 'cancelled') return name === 'cancel_event' ? { ok: true, code: 'already_cancelled', event: { ...event } } : { ok: false, code: 'event_cancelled' };
    if (fields) {
      const overlap = state.events.find(e => e.calendarId === calendarId && e.status === 'active' && e.id !== event?.id && e.startUtc < fields.endUtc && e.endUtc > fields.startUtc);
      if (overlap) return { ok: false, code: overlap.startUtc === fields.startUtc && overlap.endUtc === fields.endUtc ? 'duplicate' : 'conflict' };
    }
    if (state.failNextMutation) { state.failNextMutation = false; return { ok: false, code: 'dependency_failure' }; }
    if (name === 'cancel_event' && event) { event.status = 'cancelled'; return { ok: true, code: 'cancelled', event: { ...event } }; }
    if (fields) {
      if (name === 'update_event' && event) {
        Object.assign(event, { title: fields.title, startUtc: fields.startUtc, endUtc: fields.endUtc, timeZone: fields.timeZone });
        return { ok: true, code: 'updated', event: { ...event } };
      }
      const created: CalendarEvent = { id: randomUUID(), calendarId: calendar.id, ownerId: actor, title: fields.title, startUtc: fields.startUtc, endUtc: fields.endUtc, timeZone: fields.timeZone, status: 'active' };
      state.events.push(created); return { ok: true, code: 'created', event: { ...created } };
    }
    return { ok: false, code: 'invalid_arguments' };
  }
}
export function calendarSeed(failNextMutation = false): CalendarState {
  return { calendars: [{ id: 'personal', ownerId: 'alice' }, { id: 'restricted', ownerId: 'bob' }],
    permissions: [{ calendarId: 'restricted', actorId: 'alice', access: 'read' }],
    events: [{ id: 'existing', calendarId: 'personal', ownerId: 'alice', title: 'Team sync', startUtc: '2026-11-08T17:00:00.000Z', endUtc: '2026-11-08T18:00:00.000Z', timeZone: 'America/Los_Angeles', status: 'active' }], calls: [], failNextMutation };
}
