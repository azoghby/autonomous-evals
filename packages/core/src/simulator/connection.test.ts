import { expect, it, vi } from 'vitest';
import { createNeonConnectionResolver, NeonConnectionError, type NeonConnectionConfig } from './connection.js';
import type { BranchOwnership } from './neon.js';

function fixture(overrides: Partial<NeonConnectionConfig> = {}) {
  const owned: BranchOwnership = { jobId: 'job', projectId: 'project', parentId: 'br-seed', branchId: 'br-owned',
    name: 'eval-job-12345678-1234-1234-1234-123456789abc', state: 'ready' };
  const branch = { id: owned.branchId, project_id: 'project', parent_id: 'br-seed', name: owned.name,
    default: false, protected: false, current_state: 'ready' };
  const endpoint = { id: 'ep-owned', host: 'ep-owned.us-east-2.aws.neon.tech', project_id: 'project', branch_id: 'br-owned',
    type: 'read_write', current_state: 'active', disabled: false };
  const credential = 'postgresql://runner:synthetic-test-password@ep-owned.us-east-2.aws.neon.tech/calendar?sslmode=require';
  const bodies: unknown[] = [{ branch }, { endpoints: [endpoint] }, { uri: credential }];
  let i = 0;
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify(bodies[i++]), { status: 200 }));
  const findOwnedBranch = vi.fn(async () => structuredClone(owned));
  const config: NeonConnectionConfig = { projectId: 'project', seedBranchId: 'br-seed', databaseName: 'calendar', roleName: 'runner',
    apiKey: 'synthetic-private-key', findOwnedBranch, fetch, ...overrides };
  return { owned, branch, endpoint, credential, bodies, fetch, findOwnedBranch, config, resolve: createNeonConnectionResolver(config) };
}
async function rejectsSafely(promise: Promise<unknown>, code: string) {
  const error = await promise.then(() => undefined, e => e);
  expect(error instanceof NeonConnectionError).toBe(true);
  // Boolean assertions keep even accidental credential-bearing error values out of failure output.
  expect(error?.message === code && error?.code === code).toBe(true);
  expect(error?.cause === undefined).toBe(true);
}
it.each(['active', 'idle'])('returns verified direct credentials for a connectable %s endpoint', async state => {
  const f = fixture(); f.endpoint.current_state = state;
  expect(await f.resolve(f.owned) === f.credential).toBe(true);
  expect(f.findOwnedBranch).toHaveBeenCalledTimes(2);
  const urls = f.fetch.mock.calls.map(([url]) => new URL(String(url)));
  expect(urls.map(u => u.pathname)).toEqual(['/api/v2/projects/project/branches/br-owned',
    '/api/v2/projects/project/branches/br-owned/endpoints', '/api/v2/projects/project/connection_uri']);
  expect(Object.fromEntries(urls[2]!.searchParams)).toEqual({ branch_id: 'br-owned', endpoint_id: 'ep-owned',
    database_name: 'calendar', role_name: 'runner', pooled: 'false' });
  for (const [url, init] of f.fetch.mock.calls) {
    expect(new URL(String(url)).origin).toBe('https://console.neon.tech');
    expect(init?.method).toBe('GET'); expect(init?.redirect).toBe('error'); expect(init?.body).toBeUndefined();
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect((init?.headers as Record<string,string>).Authorization === `Bearer ${f.config.apiKey}`).toBe(true);
  }
});
it.each(['creating', 'retryable', 'delete_requested', 'deleted'])('refuses ledger lifecycle %s before HTTP', async state => {
  const f = fixture(); f.owned.state = state as BranchOwnership['state'];
  await rejectsSafely(f.resolve(f.owned), 'branch_not_owned'); expect(f.fetch).not.toHaveBeenCalled();
});
it.each(['branchId', 'projectId', 'parentId', 'name', 'jobId'])('rejects forged candidate %s', async field => {
  const f = fixture(); const forged = { ...f.owned, [field]: field === 'branchId' ? 'br-other' : 'other' };
  await expect(f.resolve(forged)).rejects.toBeInstanceOf(NeonConnectionError); expect(f.fetch).not.toHaveBeenCalled();
});
it('requires an independently recorded owned branch', async () => {
  const f = fixture(); f.findOwnedBranch.mockResolvedValue(undefined as never);
  await rejectsSafely(f.resolve(f.owned), 'branch_not_owned'); expect(f.fetch).not.toHaveBeenCalled();
});
it('checks ledger again before returning credentials', async () => {
  const f = fixture(); f.findOwnedBranch.mockResolvedValueOnce(f.owned).mockResolvedValueOnce({ ...f.owned, state: 'deleted' });
  await rejectsSafely(f.resolve(f.owned), 'branch_not_owned');
});
it('refuses the configured seed even when recorded', async () => {
  const f = fixture(); f.owned.branchId = 'br-seed';
  await rejectsSafely(f.resolve(f.owned), 'branch_ownership_mismatch'); expect(f.fetch).not.toHaveBeenCalled();
});
it.each(['id', 'project_id', 'parent_id', 'name', 'default', 'protected'])('rejects branch identity or protection mismatch %s', async field => {
  const f = fixture(); Object.assign(f.branch, { [field]: ['default', 'protected'].includes(field) ? true : ['id', 'parent_id'].includes(field) ? 'br-other' : 'other' });
  await rejectsSafely(f.resolve(f.owned), 'branch_ownership_mismatch'); expect(f.fetch).toHaveBeenCalledTimes(1);
});
it.each([{ current_state: 'init' }, { current_state: 'archived' }, { current_state: 'unknown' }, { pending_state: 'ready' }])('returns not ready for branch transition %j', async changes => {
  const f = fixture(); Object.assign(f.branch, changes);
  await rejectsSafely(f.resolve(f.owned), 'branch_not_ready'); expect(f.fetch).toHaveBeenCalledTimes(1);
});
it.each([{ current_state: 'init' }, { current_state: 'unknown' }, { pending_state: 'active' }, { disabled: true }, { type: 'read_only' }])('returns not ready for endpoint %j', async changes => {
  const f = fixture(); Object.assign(f.endpoint, changes);
  await rejectsSafely(f.resolve(f.owned), 'branch_not_ready'); expect(f.fetch).toHaveBeenCalledTimes(2);
});
it.each(['project_id', 'branch_id'])('rejects an endpoint from another %s', async field => {
  const f = fixture(); Object.assign(f.endpoint, { [field]: field === 'branch_id' ? 'br-other' : 'other' });
  await rejectsSafely(f.resolve(f.owned), 'branch_ownership_mismatch'); expect(f.fetch).toHaveBeenCalledTimes(2);
});
it.each(['ep-default.us-east-2.aws.neon.tech', 'ep-owned.evil.example', 'ep-owned.neon.tech.evil.example', 'https://ep-owned.neon.tech'])('rejects malformed or mismatched endpoint host %s', async host => {
  const f = fixture(); f.endpoint.host = host;
  await rejectsSafely(f.resolve(f.owned), 'neon_connection_invalid_response');
});
it('does not choose between ambiguous writers', async () => {
  const f = fixture(); f.bodies[1] = { endpoints: [f.endpoint, f.endpoint] };
  await rejectsSafely(f.resolve(f.owned), 'neon_connection_invalid_response');
});
it.each([0, 1, 2])('rejects malformed response at stage %s', async stage => {
  const f = fixture(); f.bodies[stage] = {};
  await rejectsSafely(f.resolve(f.owned), 'neon_connection_invalid_response');
});
it('requires explicit protection and disabled flags', async () => {
  const f = fixture(); delete (f.branch as Partial<typeof f.branch>).protected;
  await rejectsSafely(f.resolve(f.owned), 'neon_connection_invalid_response');
  const g = fixture(); delete (g.endpoint as Partial<typeof g.endpoint>).disabled;
  await rejectsSafely(g.resolve(g.owned), 'neon_connection_invalid_response');
});
it.each(['wrong-host', 'pooler', 'database', 'role', 'protocol', 'password', 'port', 'fragment', 'host-override', 'options', 'ssl', 'duplicate'])('rejects credential URI %s mismatch without exposing it', async kind => {
  const f = fixture(); const u = new URL(f.credential);
  if (kind === 'wrong-host') u.hostname = 'ep-default.us-east-2.aws.neon.tech';
  if (kind === 'pooler') u.hostname = 'ep-owned-pooler.us-east-2.aws.neon.tech';
  if (kind === 'database') u.pathname = '/other'; if (kind === 'role') u.username = 'other';
  if (kind === 'protocol') u.protocol = 'https:'; if (kind === 'password') u.password = '';
  if (kind === 'port') u.port = '4444'; if (kind === 'fragment') u.hash = 'ignored';
  if (kind === 'host-override') u.searchParams.set('host', 'ep-default.neon.tech');
  if (kind === 'options') u.searchParams.set('options', 'endpoint=ep-default');
  if (kind === 'ssl') u.searchParams.set('sslmode', 'disable');
  if (kind === 'duplicate') u.searchParams.append('sslmode', 'require');
  f.bodies[2] = { uri: kind === 'protocol' ? f.credential.replace('postgresql:', 'https:') : u.toString() };
  await rejectsSafely(f.resolve(f.owned), 'neon_connection_invalid_response');
});
it.each([301, 302, 401, 403, 404, 500])('sanitizes HTTP %s and discards its credential-bearing body', async status => {
  const f = fixture(); const response = new Response(f.credential, { status }); const cancel = vi.spyOn(response.body!, 'cancel');
  f.fetch.mockResolvedValueOnce(response);
  await rejectsSafely(f.resolve(f.owned), 'neon_connection_http_error'); expect(cancel).toHaveBeenCalled(); expect(f.fetch).toHaveBeenCalledTimes(1);
});
it.each([423, 429, 503])('returns safe not ready for HTTP %s without retrying', async status => {
  const f = fixture(); f.fetch.mockResolvedValueOnce(new Response(f.credential, { status }));
  await rejectsSafely(f.resolve(f.owned), 'branch_not_ready'); expect(f.fetch).toHaveBeenCalledTimes(1);
});
it('sanitizes transport and ledger errors', async () => {
  const f = fixture(); f.fetch.mockRejectedValueOnce(new Error(f.credential));
  await rejectsSafely(f.resolve(f.owned), 'neon_connection_request_failed');
  const g = fixture(); g.findOwnedBranch.mockRejectedValueOnce(new Error(g.credential));
  await rejectsSafely(g.resolve(g.owned), 'neon_connection_request_failed');
});
it('bounds response size while streaming and cancels the reader', async () => {
  const f = fixture({ maxResponseBytes: 8 }); let cancelled = false;
  f.fetch.mockResolvedValueOnce(new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(9)); }, cancel() { cancelled = true; } })));
  await rejectsSafely(f.resolve(f.owned), 'neon_connection_invalid_response'); expect(cancelled).toBe(true);
});
it('bounds hung fetch even when the injected transport ignores abort', async () => {
  const f = fixture({ timeoutMs: 10 }); f.fetch.mockImplementationOnce(() => new Promise(() => {}));
  await rejectsSafely(f.resolve(f.owned), 'neon_connection_timeout'); expect(f.fetch).toHaveBeenCalledTimes(1);
});
it('bounds slow response bodies and never continues to credentials after deadline', async () => {
  const f = fixture({ timeoutMs: 10 }); f.fetch.mockResolvedValueOnce(new Response(new ReadableStream({ start() {} })));
  await rejectsSafely(f.resolve(f.owned), 'neon_connection_timeout'); expect(f.fetch).toHaveBeenCalledTimes(1);
});
it('sanitizes malformed JSON', async () => {
  const f = fixture(); f.fetch.mockResolvedValueOnce(new Response(`{${f.credential}`));
  await rejectsSafely(f.resolve(f.owned), 'neon_connection_invalid_response');
});
it.each([{ apiKey: '' }, { apiKey: 'bad\r\nkey' }, { projectId: '../other' }, { databaseName: '' },
  { roleName: 'bad\u0000' }, { timeoutMs: 30_001 }, { maxResponseBytes: 1_000_001 }])('rejects invalid trusted config', changes => {
  expect(() => fixture(changes)).toThrow('invalid_neon_connection_config');
});
it('encodes explicit database/role query values and validates their decoded URI values', async () => {
  const f = fixture({ databaseName: 'calendar & notes', roleName: 'runner+eval' });
  const uri = f.credential.replace('runner:', 'runner%2Beval:').replace('/calendar?', '/calendar%20%26%20notes?');
  f.bodies[2] = { uri };
  expect(await f.resolve(f.owned) === uri).toBe(true);
  const query = new URL(String(f.fetch.mock.calls[2]![0])).searchParams;
  expect(query.get('database_name')).toBe('calendar & notes'); expect(query.get('role_name')).toBe('runner+eval');
});
it('ignores a read-only sibling while selecting the unique owned writer', async () => {
  const f = fixture(); f.bodies[1] = { endpoints: [{ ...f.endpoint, id: 'ep-reader', type: 'read_only' }, f.endpoint] };
  expect(await f.resolve(f.owned) === f.credential).toBe(true);
});
it('returns not ready when no endpoint exists', async () => {
  const f = fixture(); f.bodies[1] = { endpoints: [] };
  await rejectsSafely(f.resolve(f.owned), 'branch_not_ready'); expect(f.fetch).toHaveBeenCalledTimes(2);
});
it('rejects an already-followed redirect even from an injected transport', async () => {
  const f = fixture(); const response = new Response(JSON.stringify(f.bodies[0]));
  Object.defineProperty(response, 'redirected', { value: true }); f.fetch.mockResolvedValueOnce(response);
  await rejectsSafely(f.resolve(f.owned), 'neon_connection_http_error');
});
it('bounds a hung ownership lookup without making any remote request', async () => {
  const f = fixture({ timeoutMs: 10 }); f.findOwnedBranch.mockImplementationOnce(() => new Promise(() => {}));
  await rejectsSafely(f.resolve(f.owned), 'neon_connection_timeout'); expect(f.fetch).not.toHaveBeenCalled();
});
it('exposes only safe retryability classifications', () => {
  expect(new NeonConnectionError('branch_not_ready').retryable).toBe(true);
  expect(new NeonConnectionError('neon_connection_timeout').retryable).toBe(true);
  expect(new NeonConnectionError('branch_not_owned').retryable).toBe(false);
  expect(new NeonConnectionError('neon_connection_invalid_response').retryable).toBe(false);
});
