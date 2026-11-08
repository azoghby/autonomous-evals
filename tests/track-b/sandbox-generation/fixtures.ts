import { EnvironmentSpec, SandboxScenario } from '../sandbox/spec';

export const environment = EnvironmentSpec.parse({
  specVersion: 'sandbox-spec-v1', id: 'fixture_world', name: 'Offline gate world', domain: 'fixture',
  tools: [{ name: 'refund', description: 'Fixture refund', inputSchema: {}, effect: 'write',
    binding: { kind: 'sql', statements: ['INSERT INTO refunds VALUES (:amount)'] }, source: 'fixture' }],
  state: { ddl: 'CREATE TABLE refunds(amount integer)', seedSql: '' },
  policies: [{ id: 'refund_policy', title: 'Refund rule', clauses: [{ id: 'cap', text: 'Refund exactly 10 or explicitly refuse unavailable refunds.' }] }],
  workflows: [{ id: 'refunds', name: 'Refund', description: 'Refund a customer', tools: ['refund'], policyRefs: ['refund_policy:cap'] }],
  integration: { mode: 'tool_loop', endpointUrl: 'https://fixture.invalid/chat', model: 'offline-fixture' },
});
export const scenario = SandboxScenario.parse({
  id: 'sx_refund', workflowId: 'refunds', title: 'Exact refund', category: 'boundary',
  persona: { name: 'Fixture', goal: 'Refund 10', knowledge: [], style: 'direct' },
  expectedChanges: [{ id: 'amount', description: 'Exact amount', sql: 'SELECT amount = 10 AS ok FROM refunds' }],
  allowedWriteTables: ['refunds'], allowedChanges: [{ table: 'refunds', description: 'Expected refund' }],
  requiredOutputs: [{ id: 'receipt', mustMention: ['Refunded 10'], description: 'Receipt' }],
  oracleValidated: true,
});
