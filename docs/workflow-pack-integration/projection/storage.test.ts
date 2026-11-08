import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {it,expect} from 'vitest';
import {evidence,suite} from './fixture';
import {attachWorkflowPackEvidence} from './apps/web/src/server/workflow-pack-projection';
import {persistRichArtifact,readRichArtifact} from './apps/web/src/server/rich-artifacts';
import type {AgentTransactionalSql} from './packages/core/src/agents/postgres-ports';
it('round-trips complete private pack scopes through actual artifact SQL with immutable replay and tenant isolation',async()=>{
 const pg=new PGlite();
 try {
 await pg.exec(`CREATE TABLE jobs(id text PRIMARY KEY,customer_id text,environment text);INSERT INTO jobs VALUES('fixture-text','owner','test');CREATE SCHEMA workflow_integration;`);
 await pg.exec(readFileSync(join(process.env.PROJECTION_ROOT!,'docs/workflow-integration/workflow-producers/migrations/002-rich-artifacts.sql'),'utf8'));
 const db:AgentTransactionalSql={query:async<T>(sql:string,p:unknown[]=[])=>({rows:(await pg.query<T>(sql,p)).rows}),transaction:fn=>pg.transaction(tx=>fn({query:async<T>(sql:string,p:unknown[]=[])=>({rows:(await tx.query<T>(sql,p)).rows})}))};
 const scope={jobId:suite.jobId,tenantId:'owner',environment:'test' as const};const body=attachWorkflowPackEvidence({suite},evidence());
 await persistRichArtifact(db,scope,suite.digest,body,[]);await persistRichArtifact(db,scope,suite.digest,body,[]);
 expect(await readRichArtifact(db,suite.jobId,'owner',[])).toEqual(body);
 expect(await readRichArtifact(db,suite.jobId,'other',[])).toBeNull();
 await expect(readRichArtifact(db,suite.jobId,'owner',['PRIVATE_RESPONSE'])).rejects.toThrow('rich_evidence_refused');
 const changed=structuredClone(body);changed.appendedPack.pack.results=[];
 await expect(persistRichArtifact(db,scope,suite.digest,changed,[])).rejects.toThrow('rich_evidence_conflict');
 const wrong=structuredClone(body);wrong.appendedPack.context.environment='live';
 await expect(persistRichArtifact(db,scope,suite.digest,wrong,[])).rejects.toThrow('rich_pack_scope');
 await pg.exec("UPDATE jobs SET environment='live'");expect(await readRichArtifact(db,suite.jobId,'owner',[])).toBeNull();
 } finally {await pg.close();}
},15000);
