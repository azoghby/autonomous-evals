import { describe, expect, it, vi } from "vitest";
import { createInternalMcpHandler, type InternalMcpDependencies } from "./naive-internal-mcp";
const credential = { id: "credential", role: "copilot" as const, agentId: "agent", agentVersion: 1 };
const snapshot = {jobId:"job",observedAt:"2026-11-08T00:00:00Z",status:"running" as const,statusEvidenceRef:"job:status",milestones:[],findings:[],blockers:[],costs:[],unknownCosts:true};
function ports(): InternalMcpDependencies {
 return {authenticate:vi.fn(async()=>credential),read:vi.fn(async()=>snapshot),auditDenied:vi.fn(async()=>{}),rateLimit:vi.fn(async()=>true)};
}
function request(method:string,params?:unknown, bearer="private-key") {
 return new Request("https://example.test/api/mcp/internal/mcp",{method:"POST",headers:{authorization:`Bearer ${bearer}`,"content-type":"application/json",accept:"application/json, text/event-stream"},body:JSON.stringify({jsonrpc:"2.0",id:1,method,...(params===undefined?{}:{params})})});
}
async function rpc(response:Response) {
 const body=await response.text();
 if(response.headers.get("content-type")?.includes("text/event-stream")) {
  const data=body.split("\n").filter(l=>l.startsWith("data: ")).map(l=>JSON.parse(l.slice(6)));
  return data.find(d=>d.id===1);
 }
 return JSON.parse(body);
}
describe("internal streamable MCP transport",()=>{
 it("exposes only get_progress_snapshot and calls real SDK with task token",async()=>{
  const deps=ports(),handle=createInternalMcpHandler(deps);
  const list=await rpc(await handle(request("tools/list")));
  expect(list.result.tools.map((t:{name:string})=>t.name)).toEqual(["get_progress_snapshot"]);
  expect(list.result.tools[0].inputSchema.additionalProperties).toBe(false);
  const call=await rpc(await handle(request("tools/call",{name:"get_progress_snapshot",arguments:{task_token:"signed-task"}})));
  expect(JSON.parse(call.result.content[0].text)).toEqual(snapshot);
  expect(deps.read).toHaveBeenCalledWith(credential,{taskToken:"signed-task"});
 });
 it("rejects selectors, unknown tools, oversized bodies and non-POST transports",async()=>{
  const deps=ports(),handle=createInternalMcpHandler(deps);
  for(const argumentsValue of [{task_token:"ok",jobId:"other"},{jobId:"other"}]) expect((await handle(request("tools/call",{name:"get_progress_snapshot",arguments:argumentsValue}))).status).toBe(400);
  expect((await handle(request("tools/call",{name:"other",arguments:{task_token:"ok"}}))).status).toBe(400);
  expect((await handle(request("tools/call",{name:"get_progress_snapshot",arguments:{task_token:"x".repeat(17000)}}))).status).toBe(413);
  for(const method of ["GET","DELETE"]) expect((await handle(new Request("https://example.test/api/mcp/internal/mcp",{method}))).status).toBe(405);
  expect(deps.read).not.toHaveBeenCalled();
 });
 it("fails closed for authentication, throttling and audit outages",async()=>{
  const deps=ports(),handle=createInternalMcpHandler(deps);
  vi.mocked(deps.authenticate).mockResolvedValue(null);
  expect((await handle(request("tools/list"))).status).toBe(401);
  vi.mocked(deps.authenticate).mockResolvedValue(credential);
  vi.mocked(deps.rateLimit).mockResolvedValue(false);
  expect((await handle(request("tools/list"))).status).toBe(429);
  vi.mocked(deps.auditDenied).mockRejectedValue(new Error("private payload"));
  const result=await handle(request("tools/list"));
  expect(result.status).toBe(503); expect(await result.text()).not.toContain("private payload");
 });
 it("keeps concurrent credential contexts isolated and bounds returned snapshots",async()=>{
  const deps=ports();
  deps.authenticate=async bearer=>({...credential,id:bearer});
  deps.read=vi.fn(async(c)=>({...snapshot,jobId:c.id}));
  const handle=createInternalMcpHandler(deps);
  const results=await Promise.all(["one","two"].map(async key=>rpc(await handle(request("tools/call",{name:"get_progress_snapshot",arguments:{task_token:key}},key)))));
  expect(results.map(result=>JSON.parse(result.result.content[0].text).jobId)).toEqual(["one","two"]);
  vi.mocked(deps.read).mockResolvedValue({...snapshot,private:"secret"} as never);
  const denied=await rpc(await handle(request("tools/call",{name:"get_progress_snapshot",arguments:{task_token:"ok"}})));
  expect(denied.result.isError).toBe(true); expect(JSON.stringify(denied)).not.toContain("secret");
 });
});
