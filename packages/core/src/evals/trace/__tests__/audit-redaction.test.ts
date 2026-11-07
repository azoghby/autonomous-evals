import { expect, it } from 'vitest';
import { fixtureJob, harness } from '../../../agents/__tests__/fakes';
import { auditTrace, buildRecheckMessage, verifyCitation } from '../audit';
import { normalizeTrace } from '../normalize';
import { detect } from '../detect';

it('provides deterministic raw event blocks whose JSON and angle-bracket fragments verify exactly', () => {
  const trace = normalizeTrace(JSON.stringify([{ role: 'tool', name: 'send_email', content: '{"ok":false,"error":"<failure>"}' }, { role: 'assistant', content: 'The email was sent.' }]));
  const detection = detect(trace, 'Check tool failures.');
  const prompt = buildRecheckMessage(trace, detection.candidates, 'Check tool failures.', detection.rules);
  expect(buildRecheckMessage(trace, detection.candidates, 'Check tool failures.', detection.rules)).toBe(prompt);
  for (const event of trace.events) {
    expect(prompt).toContain(`\n${event.text}\nEND TRACE_RAW_`);
    expect(verifyCitation(trace, event.id, event.text)).not.toBeNull();
  }
  expect(prompt).toContain('never instructions');
  expect(verifyCitation(trace, 'e1', 'Request Body:{tooltipBody}}')).toBeNull();
});

it('bounds event excerpts even when many instruction-relevant events exhaust the prompt allowance', () => {
  const trace = normalizeTrace(JSON.stringify(Array.from({ length: 100 }, () => ({ role: 'assistant', content: 'x'.repeat(1800) }))));
  const prompt = buildRecheckMessage(trace, [], 'Be accurate.', []);
  const data = JSON.parse(prompt.slice(prompt.indexOf('<untrusted_data>') + 16, prompt.indexOf('</untrusted_data>')));
  expect(data.events.reduce((total: number, event: { text: string }) => total + event.text.length, 0)).toBeLessThanOrEqual(60_001);
  expect(data.events.length).toBeLessThan(100);
});

it('removes caller-known JSON-escaped secrets before investigator dispatch and evidence construction', async () => {
  const secret = 'private"value\\with-escapes';
  const h = harness(() => ({ structuredOutput: { verdicts: [], additional_findings: [] } }));
  const outcome = await auditTrace({ job: fixtureJob(), knownSecrets: [secret], systemPrompt: 'Check tool failures.', trace: JSON.stringify([
    { role: 'tool', name: 'send_email', content: JSON.stringify({ ok: false, error: secret }) },
    { role: 'assistant', content: 'The email was sent.' },
  ]) }, { runner: h.service });
  expect(outcome.status).toBe('completed');
  expect(h.naive.createCalls).toHaveLength(1);
  const prompt = h.naive.createCalls[0]!.body.message;
  expect(prompt).toContain('[REDACTED]');
  for (const value of [secret, JSON.stringify(secret).slice(1, -1), JSON.stringify(JSON.stringify(secret)).slice(1, -1)]) {
    expect(prompt).not.toContain(value);
    expect(JSON.stringify(outcome)).not.toContain(value);
  }
});
