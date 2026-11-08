import { describe, it, expect, vi, beforeEach } from 'vitest';
const intake = vi.hoisted(() => vi.fn());
vi.mock('@/server/data-production', () => ({ humanDataReview: intake }));
import { GET, POST } from './route';
const ctx = { params: Promise.resolve({ jobId: 'job-a' }) };
const url = 'https://app.example/api/jobs/job-a/data-review';
const post = (body: unknown, headers: Record<string,string> = {origin:'https://app.example','content-type':'application/json'}) => new Request(url, { method:'POST', headers, body:JSON.stringify(body) });
beforeEach(() => { intake.mockReset(); });
describe('authenticated data intake route', () => {
  it('passes job and exact digest to authenticated server reader', async () => {
    intake.mockResolvedValue({task:{taskId:'task-a'},candidates:{sources:[],cases:[]}});
    const response = await GET(new Request(url+'?digest=abc'), ctx);
    expect(response.status).toBe(200); expect(intake).toHaveBeenCalledWith('job-a','abc');
  });
  it('forwards explicit review fields only', async () => {
    intake.mockResolvedValue({status:'recorded'});
    const reviewed = {sources:[],cases:[]};
    expect((await POST(post({digest:'abc',receiptId:'receipt',decision:'approved',reviewed}),ctx)).status).toBe(200);
    expect(intake).toHaveBeenCalledWith('job-a','abc',{receiptId:'receipt',decision:'approved',reviewed});
  });
  it('blocks cross-origin, missing-origin and non-JSON submissions before intake', async () => {
    for (const headers of [{origin:'https://attacker.example','content-type':'application/json'},{'content-type':'application/json'},{origin:'https://app.example','content-type':'text/plain'}]) {
      expect((await POST(post({},headers),ctx)).status).toBe(403);
    }
    expect(intake).not.toHaveBeenCalled();
  });
  it('bounds streaming bodies and refuses caller principal/task fields', async () => {
    expect((await POST(post({digest:'abc',principalId:'forged'}),ctx)).status).toBe(403);
    expect((await POST(post({reviewed:'x'.repeat(500_001)}),ctx)).status).toBe(403);
    expect(intake).not.toHaveBeenCalled();
  });
  it('returns fixed safe errors without provider/session details', async () => {
    intake.mockRejectedValue(new Error('private-provider-token'));
    const response=await GET(new Request(url+'?digest=abc'),ctx);
    expect(await response.text()).toBe('{"error":"Data review unavailable"}');
  });
});
