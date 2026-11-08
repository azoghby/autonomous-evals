import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'vitest';
import { blockedOperatorCosts, failedServicesRetainMeasuredCosts, pendingThenSettledCosts, lostCostAcknowledgement, reportSnapshotCharacterization } from './cases';
for (const [name, run] of [
  ['acceptance: failed qualification and schema-failed operator costs survive disk reopen and report replay', failedServicesRetainMeasuredCosts],
  ['acceptance: pending reserves without fabricated costs, then settles once across resume', pendingThenSettledCosts],
  ['acceptance: committed cost with lost ACK replays once after disk reopen', lostCostAcknowledgement],
  ['CURRENT DEFECT: JSON report aliases caller cost rows while totals and rendered snapshots stay fixed', reportSnapshotCharacterization],
] as const) it(name, async () => {
  const path = await mkdtemp(join(tmpdir(), 'release-cost-sql-'));
  try { await run(path); } finally { await rm(path, { recursive: true, force: true }); }
}, 30_000);

for (const state of ['budget_paused', 'awaiting_input'] as const) it(`acceptance: operator ${state} records measured cost before blocking/fallback and replays once`, async () => {
  const path = await mkdtemp(join(tmpdir(), 'release-cost-blocked-'));
  try { await blockedOperatorCosts(path, state); } finally { await rm(path, { recursive: true, force: true }); }
}, 30_000);
