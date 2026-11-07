import { expect, it } from 'vitest';
import { fixtureJob, harness } from '../../../agents/__tests__/fakes';
import { auditTrace } from '../audit';

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
