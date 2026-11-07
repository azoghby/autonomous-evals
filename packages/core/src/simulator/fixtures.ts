import type { ChatMessage, ChatTarget, ToolCall } from '../targets/chat.js';
/** Internal demo fixtures only: never customer executions or live SDK verification. */
export function internalCalendarFixture(mode: 'buggy' | 'fixed', call: ToolCall): ChatTarget {
  return { async complete(messages: ChatMessage[]) {
    const last = messages.at(-1);
    if (last?.role !== 'tool') return { role: 'assistant', content: null, tool_calls: [structuredClone(call)] };
    const result = JSON.parse(last.content) as { ok: boolean };
    return { role: 'assistant', content: mode === 'buggy' || result.ok ? 'Booked successfully.' : 'Booking failed; no event was created.' };
  } };
}
