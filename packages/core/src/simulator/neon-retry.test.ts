import { it, expect, vi, afterEach } from 'vitest';
import { NeonBranchService, NeonHttpApi, type BranchLedger, type BranchOwnership } from './neon.js';

afterEach(() => vi.unstubAllGlobals());
it('Neon documents 423/503 as safe-to-retry (request not applied); a 423 on create must not strand the job', async () => {
  let record: BranchOwnership | undefined;
  const ledger: BranchLedger = { withJobLock: async (_j, fn) => fn(record, async r => { record = structuredClone(r); }) };
  let posts = 0;
  vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => {
    posts++;
    if (posts === 1) return new Response(JSON.stringify({ code: 'PROJECT_LOCKED', message: 'locked' }), { status: 423 });
    const body = JSON.parse(String(init.body)) as { branch: { name: string } };
    return new Response(JSON.stringify({ branch: { id: 'br-new-123', project_id: 'proj-1', parent_id: 'br-seed', name: body.branch.name, default: false, protected: false } }), { status: 201 });
  }));
  const svc = new NeonBranchService(new NeonHttpApi('k'), ledger, 'proj-1', 'br-seed');
  await expect(svc.createJobBranch('job-1')).rejects.toThrow();
  // Caller retry (same job) after the documented-safe 423: currently throws branch_requires_reconciliation forever.
  await expect(svc.createJobBranch('job-1')).resolves.toMatchObject({ state: 'ready', branchId: 'br-new-123' });
});
