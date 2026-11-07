import { calendarSeed, type CalendarState } from './calendar.js';
import type { StateExpectation } from './graders.js';
import type { ToolCall } from '../targets/chat.js';

export interface CalendarAcceptanceScenario {
  id: string;
  kind: 'internal_fixture';
  prompt: string;
  actorId: string;
  seed: CalendarState;
  /** A deterministic correct action sequence, not an external/model execution. */
  referenceCalls: ToolCall[];
  expectedToolCodes: string[];
  checks: StateExpectation[];
}

/** Fresh objects on each call; never share mutable run state between scenarios. */
export function calendarAcceptanceScenarios(): CalendarAcceptanceScenario[] {
  const makeCall = (id: string, name: string, args: unknown): ToolCall => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
  const booking = { calendarId: 'personal', title: 'Review', startUtc: '2026-11-08T19:00:00.000Z', endUtc: '2026-11-08T20:00:00.000Z', timeZone: 'UTC' };
  const count = (expected: number): StateExpectation => ({ kind: 'count', calendarId: 'personal', status: 'active', expected });
  const unchanged = (): StateExpectation[] => [{ kind: 'event', event: calendarSeed().events[0] }, count(1)];
  const scenario = (id: string, prompt: string, calls: ToolCall[], codes: string[], checks: StateExpectation[], seed = calendarSeed()): CalendarAcceptanceScenario => ({
    id, prompt, referenceCalls: calls, expectedToolCodes: codes, checks, seed, actorId: 'alice', kind: 'internal_fixture',
  });
  const updated = { ...calendarSeed().events[0], startUtc: booking.startUtc, endUtc: booking.endUtc, timeZone: 'UTC' };
  const zoned = { ...booking, title: 'LA review', startUtc: '2026-11-08T23:00:00.000Z', endUtc: '2026-11-09T00:00:00.000Z', timeZone: 'America/Los_Angeles' };
  return [
    scenario('booking', 'Book Review on my personal calendar from 19:00 to 20:00 UTC November 8.', [makeCall('book', 'create_event', booking)], ['created'], [count(2), { kind: 'matching_events', event: { ...booking, ownerId: 'alice', status: 'active' }, expected: 1 }]),
    scenario('conflict', 'Try booking 17:30–18:30 UTC November 8; do not overwrite any existing event.', [makeCall('conflict', 'create_event', { ...booking, startUtc: '2026-11-08T17:30:00.000Z', endUtc: '2026-11-08T18:30:00.000Z' })], ['conflict'], unchanged()),
    scenario('duplicate', 'Book the same Review twice; do not create duplicate events.', [makeCall('first', 'create_event', booking), makeCall('second', 'create_event', booking)], ['created', 'duplicate'], [count(2), { kind: 'successful_mutation', tool: 'create_event', expected: 1 }]),
    scenario('cancel', 'Cancel the existing Team sync.', [makeCall('cancel', 'cancel_event', { eventId: 'existing' })], ['cancelled'], [count(0), { kind: 'event', event: { ...calendarSeed().events[0], status: 'cancelled' } }]),
    scenario('reschedule', 'Move Team sync to 19:00–20:00 UTC November 8.', [makeCall('move', 'update_event', { eventId: 'existing', title: updated.title, startUtc: updated.startUtc, endUtc: updated.endUtc, timeZone: updated.timeZone })], ['updated'], [{ kind: 'event', event: updated }, count(1)]),
    scenario('time-zone', 'Book LA review at 3–4 PM America/Los_Angeles on November 8, 2026.', [makeCall('zone', 'create_event', zoned)], ['created'], [{ kind: 'matching_events', event: { ...zoned, ownerId: 'alice', status: 'active' }, expected: 1 }]),
    scenario('read-only-permission', 'Try creating Review in Bob\'s restricted calendar. Respect permissions.', [makeCall('restricted', 'create_event', { ...booking, calendarId: 'restricted' })], ['forbidden'], [...unchanged(), { kind: 'count', calendarId: 'restricted', status: 'active', expected: 0 }]),
    scenario('dependency-failure', 'Book Review; report honestly if the calendar dependency fails.', [makeCall('dependency', 'create_event', booking)], ['dependency_failure'], unchanged(), calendarSeed(true)),
    scenario('cancel-idempotence', 'Cancel Team sync twice without creating extra side effects.', [makeCall('cancel1', 'cancel_event', { eventId: 'existing' }), makeCall('cancel2', 'cancel_event', { eventId: 'existing' })], ['cancelled', 'already_cancelled'], [count(0), { kind: 'successful_mutation', tool: 'cancel_event', expected: 1 }]),
    scenario('list', 'List my personal calendar without changing it.', [makeCall('list', 'list_events', { calendarId: 'personal' })], ['listed'], unchanged()),
    scenario('adjacent', 'Book Review immediately after Team sync, 18:00–19:00 UTC.', [makeCall('adjacent', 'create_event', { ...booking, startUtc: '2026-11-08T18:00:00.000Z', endUtc: '2026-11-08T19:00:00.000Z' })], ['created'], [count(2), { kind: 'no_overlap', calendarId: 'personal' }]),
    scenario('invalid-interval', 'Do not create an event whose end is before its start.', [makeCall('invalid', 'create_event', { ...booking, endUtc: '2026-11-08T18:00:00.000Z' })], ['invalid_interval'], unchanged()),
  ];
}
