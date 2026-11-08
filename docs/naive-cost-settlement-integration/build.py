#!/usr/bin/env python3
"""Rebuild exact-base owner patch without changing application files."""
from pathlib import Path
import subprocess,json,hashlib,difflib
ROOT=Path(__file__).resolve().parents[2]
OUT=Path(__file__).resolve().parent
POST=OUT/'postimages'
BASE='4d9842b10ae13e7bc721394687aec54b9010dc01'
def old(p):
 r=subprocess.run(['git','show',f'{BASE}:{p}'],cwd=ROOT,capture_output=True)
 return r.stdout.decode() if r.returncode==0 else None
def save(p,s):
 f=POST/p; f.parent.mkdir(parents=True,exist_ok=True);f.write_text(s)
p='packages/core/src/contracts/index.ts';s=old(p).replace('source: z.enum(["naive", "ai_gateway"]),','source: z.enum(["naive", "naive_proxy", "ai_gateway"]),').replace('  sessionId: z.string().optional(),\n  microUsd:', '  sessionId: z.string().optional(),\n  requestId: z.string().optional(),\n  microUsd:');save(p,s)
p='packages/core/src/db/schema.ts';s=old(p).replace('source: text("source").notNull(), // naive | ai_gateway','source: text("source").notNull(), // naive | naive_proxy | ai_gateway');s=s.replace('}, (t) => [index("costs_job_idx").on(t.jobId)]);','  receiptKey: text("receipt_key"),\n  receiptIdentity: jsonb("receipt_identity"),\n}, (t) => [index("costs_job_idx").on(t.jobId), uniqueIndex("costs_provider_receipt_uq").on(t.source, t.receiptKey).where(sql`${t.receiptKey} is not null`)]);');save(p,s)
p='apps/web/src/server/job-store.ts';s=old(p);s=s.replace('import "server-only";','import "server-only";\nimport { recordSettledCost } from "./cost-settlement";');start=s.index('export async function recordCost(');end=s.index('\n/** Persists findings.',start);s=s[:start]+'''export async function recordCost(entry: CostEntry, expected?: { ownerId: string; environment: Environment }): Promise<void> {
  const e = CostEntry.parse(entry);
  await recordSettledCost({ kind: "job", id: e.jobId, ...expected }, e);
}
''' + s[end:];s=s.replace('recordCost: (entry) => recordCost({ ...entry, jobId }),','recordCost: (entry) => recordCost({ ...entry, jobId }, { ownerId: job.customerId, environment }),');save(p,s)
p='apps/web/src/server/sandbox/store.ts';s=old(p).replace('import "server-only";','import "server-only";\nimport { recordSettledCost } from "../cost-settlement";');s=s.replace('entry: Parameters<GatewayContext["recordCost"]>[0]): Promise<void>;','entry: Parameters<GatewayContext["recordCost"]>[0]): Promise<void | { inserted: boolean }>;');start=s.index('    async addCost(target, entry) {');end=s.index('\n    },',start);s=s[:start]+'''    async addCost(target, entry) {
      return recordSettledCost(target, entry);''' + s[end:];s=s.replace('      spent += entry.microUsd;\n      await store.addCost(target, entry);','      const settlement = await store.addCost(target, entry);\n      if (settlement?.inserted !== false) spent += entry.microUsd;');save(p,s)
p='packages/core/src/db/migrations/0023_cost_receipts.sql';save(p,'''-- Existing rows are deliberately not backfilled or deleted. Inventory/reconcile legacy Naive
-- receipts before activation; the sink refuses matching unkeyed historical receipts.
ALTER TABLE "costs" ADD COLUMN "receipt_key" text;
--> statement-breakpoint
ALTER TABLE "costs" ADD COLUMN "receipt_identity" jsonb;
--> statement-breakpoint
CREATE UNIQUE INDEX "costs_provider_receipt_uq" ON "costs" USING btree ("source","receipt_key") WHERE "costs"."receipt_key" is not null;
''')
p='packages/core/src/db/migrations/meta/_journal.json';j=json.loads(old(p));j['entries'].append({'idx':23,'version':'7','when':1794117812953,'tag':'0023_cost_receipts','breakpoints':True});save(p,json.dumps(j,indent=2)+'\n')
p='packages/core/src/db/migrations/meta/0023_snapshot.json';j=json.loads(old('packages/core/src/db/migrations/meta/0022_snapshot.json'));j['prevId']=j['id'];j['id']='7768bd60-6e61-421a-b5c1-c2292540d61e';t=j['tables']['public.costs'];
for name,typ in [('receipt_key','text'),('receipt_identity','jsonb')]:t['columns'][name]={'name':name,'type':typ,'primaryKey':False,'notNull':False}
t['indexes']['costs_provider_receipt_uq']={'name':'costs_provider_receipt_uq','columns':[{'expression':n,'isExpression':False,'asc':True,'nulls':'last'} for n in ['source','receipt_key']],'isUnique':True,'where':'"costs"."receipt_key" is not null','concurrently':False,'method':'btree','with':{}};save(p,json.dumps(j,indent=2)+'\n')
files=[];patch=''
for f in sorted(POST.rglob('*')):
 if not f.is_file():continue
 p=f.relative_to(POST).as_posix();before=old(p);after=f.read_text();h=lambda s:hashlib.sha256(s.encode()).hexdigest()
 files.append({'path':p,'beforeSha256':h(before) if before is not None else None,'afterSha256':h(after)})
 patch+=f'diff --git a/{p} b/{p}\n'
 if before is None:patch+='new file mode 100644\n'
 for line in difflib.unified_diff((before or '').splitlines(True),after.splitlines(True),fromfile=f'a/{p}' if before is not None else '/dev/null',tofile=f'b/{p}'):
  patch+=line if line.endswith('\n') else line+'\n\\ No newline at end of file\n'
(OUT/'owner.patch').write_text(patch)
(OUT/'manifest.json').write_text(json.dumps({'baseCommit':BASE,'files':files,'patchSha256':hashlib.sha256(patch.encode()).hexdigest(),'actualApplicationModified':False,'productionActivated':False},indent=2)+'\n')
print(f'{len(files)} owner postimages regenerated against {BASE}')
