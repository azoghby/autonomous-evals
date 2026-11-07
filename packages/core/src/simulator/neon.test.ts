import { it, expect, vi } from 'vitest';
import { NeonBranchService, type BranchLedger, type BranchOwnership, type NeonApi } from './neon.js';
import { BranchCleanupPendingError, createBranchServices } from './adapters.js';
function fixture() {
  let record: BranchOwnership | undefined;
  const ledger: BranchLedger = { withJobLock: async (_job, fn) => fn(record, async r => { record = structuredClone(r); }) };
  let branch: any;
  const api: NeonApi = { call: vi.fn(async (method, _path, body) => {
    if (method === 'POST') { const b = body as any; branch = { ...b.branch, id: 'br-owned', project_id: 'project', default: false, protected: false }; return { status: 201, body: { branch } }; }
    if (method === 'GET') return branch ? { status: 200, body: { branch } } : { status: 404 };
    branch = undefined; return { status: 200 };
  }) };
  const service = new NeonBranchService(api, ledger, 'project', 'br-seed');
  return { service, api, getRecord: () => record, getBranch: () => branch, ledger };
}
it('creates exactly once with seed parent and durably recorded random ownership', async () => {
  const f = fixture(); const first = await f.service.createJobBranch('job'); expect(await f.service.createJobBranch('job')).toEqual(first);
  expect(f.api.call).toHaveBeenCalledTimes(1); expect(f.getBranch().parent_id).toBe('br-seed');
  expect(await f.service.deleteJobBranch('job')).toEqual({ state: 'delete_requested' });
  expect(await f.service.deleteJobBranch('job')).toEqual({ state: 'deleted' });
  expect(await f.service.deleteJobBranch('job')).toEqual({ state: 'deleted' });
});
it('never retries an ambiguous branch creation', async () => {
  const f = fixture(); vi.mocked(f.api.call).mockRejectedValueOnce(new Error('ambiguous'));
  await expect(f.service.createJobBranch('job')).rejects.toThrow('ambiguous'); expect(f.getRecord()?.state).toBe('creating');
  await expect(f.service.createJobBranch('job')).rejects.toThrow('reconciliation'); expect(f.api.call).toHaveBeenCalledTimes(1);
  await expect(f.service.deleteJobBranch('job')).rejects.toThrow('reconciliation');
});
it.each([423, 503])('bounds documented-safe %s create retries to three attempts', async status => {
  const f = fixture(); vi.mocked(f.api.call).mockResolvedValue({ status });
  for (let i = 0; i < 3; i++) await expect(f.service.createJobBranch('job')).rejects.toThrow('branch_retryable_response');
  expect(f.getRecord()).toMatchObject({ state: 'retryable', createAttempts: 3 });
  await expect(f.service.createJobBranch('job')).rejects.toThrow('branch_retry_exhausted');
  expect(f.api.call).toHaveBeenCalledTimes(3);
});
it.each(['default', 'protected', 'parent_id', 'name', 'project_id', 'id'])('refuses changed ownership %s before deletion', async field => {
  const f = fixture(); await f.service.createJobBranch('job'); f.getBranch()[field] = ['default','protected'].includes(field) ? true : 'other';
  await expect(f.service.deleteJobBranch('job')).rejects.toThrow(); expect(vi.mocked(f.api.call).mock.calls.some(c => c[0] === 'DELETE')).toBe(false);
});
it('observes a pending deletion without issuing another ambiguous DELETE', async () => {
  const f = fixture(); await f.service.createJobBranch('job');
  vi.mocked(f.api.call).mockImplementation(async method => method === 'GET' ? { status: 200, body: { branch: f.getBranch() } } : { status: 200 });
  expect(await f.service.deleteJobBranch('job')).toEqual({ state: 'delete_requested' });
  expect(await f.service.deleteJobBranch('job')).toEqual({ state: 'delete_requested' });
  expect(vi.mocked(f.api.call).mock.calls.filter(([method]) => method === 'DELETE')).toHaveLength(1);
});
it('contract adapters resolve credentials only for owned branch and reject arbitrary deletion', async () => {
  const f = fixture(); const connectionString = vi.fn().mockResolvedValue('postgresql://user:password@branch.example/db?sslmode=require');
  const services = createBranchServices({ service: f.service, findOwnedBranch: async id => f.getRecord()?.branchId === id ? f.getRecord() : undefined, connectionString });
  await expect(services.deleteJobBranch('br-unowned')).rejects.toThrow('branch_not_owned'); expect(f.api.call).not.toHaveBeenCalled();
  expect(await services.createJobBranch('job')).toMatchObject({ branchId: 'br-owned' });
  expect(connectionString).toHaveBeenCalledTimes(1);
  await expect(services.deleteJobBranch('br-owned')).rejects.toBeInstanceOf(BranchCleanupPendingError);
  await expect(services.deleteJobBranch('br-owned')).resolves.toBeUndefined();
  await expect(services.deleteJobBranch('br-owned')).resolves.toBeUndefined();
  expect(vi.mocked(f.api.call).mock.calls.filter(([method]) => method === 'DELETE')).toHaveLength(1);
});
it('keeps adapter cleanup pending while the owned branch remains visible', async () => {
  const f = fixture(); await f.service.createJobBranch('job');
  vi.mocked(f.api.call).mockImplementation(async method => method === 'GET' ? { status: 200, body: { branch: f.getBranch() } } : { status: 200 });
  const services = createBranchServices({ service: f.service, findOwnedBranch: async () => f.getRecord(), connectionString: async () => '' });
  for (let i = 0; i < 3; i++) await expect(services.deleteJobBranch('br-owned')).rejects.toMatchObject({ code: 'branch_cleanup_pending' });
  expect(vi.mocked(f.api.call).mock.calls.filter(([method]) => method === 'DELETE')).toHaveLength(1);
});
