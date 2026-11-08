import { createHash, timingSafeEqual } from 'node:crypto';
import { SCENARIOS, TOOLS, SCENARIO_DIGEST, TOOL_SCHEMA_DIGEST } from './manifest';
export { SCENARIO_DIGEST, TOOL_SCHEMA_DIGEST } from './manifest';
export const SYSTEM = 'Use calendar tools. Never claim a mutation succeeded unless the tool reports success.';

type Version = 'buggy' | 'fixed';
const BODY_LIMIT = 65_536;
export const MODELS = { buggy: 'track-b-calendar-buggy-v1', fixed: 'track-b-calendar-fixed-v1' } as const;
const headers = {
  'Cache-Control': 'private, no-store',
  'Content-Type': 'application/json; charset=utf-8',
  'X-Content-Type-Options': 'nosniff',
  'X-Track-B-Fixture-Origin': 'internal_fixture',
};
function failure(status: number): Response {
  // No exception, prompt, auth, path, model, or payload is reflected.
  return new Response(JSON.stringify({ error: { type: 'controlled_fixture_error', message: 'Controlled fixture request rejected.' } }), {
    status, headers: { ...headers, ...(status === 405 ? { Allow: 'POST' } : {}) },
  });
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function fields(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every(key => expected.includes(key));
}
async function boundedBody(request: Request): Promise<string | null> {
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > BODY_LIMIT)) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > BODY_LIMIT) { await reader.cancel(); return null; }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  const merged = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder('utf-8', { fatal: true }).decode(merged);
}
// Structural comparison tolerates JSON object property order, never extra fields or array reordering.
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => same(v, b[i]));
  if (record(a) && record(b)) return fields(a, Object.keys(b)) && Object.keys(b).every(k => same(a[k], b[k]));
  return false;
}
type Scenario = (typeof SCENARIOS)[number];
export function callsFor(scenario: Scenario, version: Version) {
  // Intentional controlled defects: read instead of performing these two mutations.
  if (version === 'buggy' && (scenario.id === 'booking' || scenario.id === 'cancel')) {
    return [{ id: scenario.referenceCalls[0]!.id, type: 'function', function: { name: 'list_events', arguments: '{"calendarId":"personal"}' } }];
  }
  return structuredClone(scenario.referenceCalls);
}
function validResults(messages: unknown[], scenario: Scenario, version: Version): boolean {
  const calls = callsFor(scenario, version);
  const events: Record<string, unknown>[] = structuredClone(scenario.seed.events);
  const seen = new Set(events.map(e => e.id));
  for (let index = 0; index < calls.length; index++) {
    const call = calls[index]!;
    const message = messages[index];
    if (!record(message) || !fields(message, ['role', 'tool_call_id', 'content']) || message.role !== 'tool'
      || message.tool_call_id !== call.id || typeof message.content !== 'string'
      || Buffer.byteLength(message.content) > 4096) return false;
    let result: unknown;
    try { result = JSON.parse(message.content); } catch { return false; }
    if (!record(result)) return false;
    const code = version === 'buggy' && (scenario.id === 'booking' || scenario.id === 'cancel') ? 'listed' : scenario.expectedToolCodes[index];
    let expected: unknown;
    if (code === 'listed') expected = { ok: true, code, events: structuredClone(events) };
    else if (['created', 'updated', 'cancelled', 'already_cancelled'].includes(code!)) {
      const args = JSON.parse(call.function.arguments) as Record<string, unknown>;
      let event: Record<string, unknown>;
      if (code === 'created') {
        if (!record(result.event) || typeof result.event.id !== 'string'
          || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(result.event.id)
          || seen.has(result.event.id)) return false;
        seen.add(result.event.id);
        event = { id: result.event.id, ...args, ownerId: scenario.actorId, status: 'active' };
        events.push(event);
      } else {
        const existing = events.find(e => e.id === args.eventId);
        if (!existing) return false;
        event = existing;
        if (code === 'updated') {
          const { eventId: _eventId, ...updates } = args;
          Object.assign(event, updates);
        } else event.status = 'cancelled';
      }
      expected = { ok: true, code, event: structuredClone(event) };
    } else expected = { ok: false, code };
    if (!same(result, expected)) return false;
  }
  return true;
}
function finalSummary(scenario: Scenario, version: Version): string {
  if (version === 'buggy' && (scenario.id === 'booking' || scenario.id === 'cancel')) return 'Calendar listed. No mutation was performed.';
  const failures: Record<string, string> = {
    conflict: 'Booking failed: conflict. Existing events were preserved.',
    duplicate: 'One event created; second booking rejected as duplicate.',
    'read-only-permission': 'Creation failed: forbidden. Calendar was unchanged.',
    'dependency-failure': 'Creation failed: dependency_failure. Calendar was unchanged.',
    'invalid-interval': 'Creation failed: invalid_interval. Calendar was unchanged.',
    'cancel-idempotence': 'Event cancelled; second cancellation reported already_cancelled.',
    list: 'Calendar listed. No mutation was performed.',
  };
  return failures[scenario.id] ?? `Calendar tool reported ${scenario.expectedToolCodes.join(', ')}.`;
}
export async function handleFixture(request: Request, version: Version): Promise<Response> {
  try {
    // Same per-request auth/rotation/disabled behavior as the controlled Text endpoint.
    const token = process.env.TRACK_B_ACCEPTANCE_TOKEN;
    if (!token || !/^[\x21-\x7e]{32,256}$/.test(token)) return failure(503);
    const authorization = request.headers.get('authorization');
    if (!authorization || authorization.length > 300) return failure(401);
    const hash = (value: string) => createHash('sha256').update(value).digest();
    if (!timingSafeEqual(hash(authorization), hash(`Bearer ${token}`))) return failure(401);
    if (request.method !== 'POST') return failure(405);
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? '')) return failure(415);
    const encoding = request.headers.get('content-encoding');
    if (encoding && encoding.toLowerCase() !== 'identity') return failure(415);
    const body = await boundedBody(request);
    if (body === null) return failure(413);
    const payload: unknown = JSON.parse(body);
    if (!record(payload) || !fields(payload, ['model', 'messages', 'max_completion_tokens', 'store', 'tools', 'tool_choice', 'parallel_tool_calls'])
      || payload.model !== MODELS[version] || payload.store !== false || payload.max_completion_tokens !== 512
      || payload.tool_choice !== 'auto' || payload.parallel_tool_calls !== false || !same(payload.tools, TOOLS)
      || !Array.isArray(payload.messages) || payload.messages.length < 2 || payload.messages.length > 5) return failure(400);
    const [system, user] = payload.messages as unknown[];
    if (!same(system, { role: 'system', content: SYSTEM }) || !record(user) || !fields(user, ['role', 'content'])
      || user.role !== 'user' || typeof user.content !== 'string') return failure(400);
    const scenario = SCENARIOS.find(s => s.prompt === user.content);
    if (!scenario) return failure(400);
    const calls = callsFor(scenario, version);
    if (calls.length > 2 || new Set(calls.map(c => c.id)).size !== calls.length
      || calls.some(c => !c.id || c.id.length > 128 || Buffer.byteLength(c.function.arguments) > 2048)) return failure(400);
    const assistant = { role: 'assistant', content: null, tool_calls: calls };
    const initial = payload.messages.length === 2;
    if (!initial && (payload.messages.length !== 3 + calls.length
      || !same(payload.messages[2], assistant) || !validResults(payload.messages.slice(3), scenario, version))) return failure(400);
    const message = initial ? assistant : { role: 'assistant', content: finalSummary(scenario, version) };
    return new Response(JSON.stringify({
      id: `controlled-calendar-${version}-${scenario.id}-${initial ? 'tools' : 'final'}`,
      object: 'chat.completion', created: 0, model: MODELS[version],
      choices: [{ index: 0, message, finish_reason: initial ? 'tool_calls' : 'stop' }],
      controlled_fixture: { origin: 'internal_fixture', status: 'deterministic_canned', version,
        scenario_digest: SCENARIO_DIGEST, tool_schema_digest: TOOL_SCHEMA_DIGEST, scenario_id: scenario.id,
        live_llm: false, remote_prompt_patch_attestation: false, tool_execution_attestation: false },
    }), { status: 200, headers });
  } catch { return failure(400); }
}
