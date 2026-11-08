import {createHash} from 'node:crypto';
import {readFileSync, lstatSync, openSync, closeSync, constants} from 'node:fs';
import {resolve, join, sep} from 'node:path';
import {planReconciliation, safeRelativePath} from '../release-registry-reconciliation/planner.mjs';
import {parseUniqueJson} from '../release-registry-reconciliation/strict-json.mjs';

export const IDENTITY_SQL = `SELECT (SELECT system_identifier::text FROM pg_catalog.pg_control_system()) AS "systemIdentifier", current_database() AS "databaseName", (SELECT oid::text FROM pg_catalog.pg_database WHERE datname=current_database()) AS "databaseOid", current_user AS "currentUser"`;
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const active = new WeakSet();
const backendPids = new WeakMap();
const contextDigest = options => sha256(JSON.stringify([options.registryTable,options.lockKey,options.database,options.expectedIdentity,options.expectedManifestSha256]));
const stable = x => JSON.stringify(x);
const same = (a,b) => stable(a) === stable(b);
const identifier = name => {
  if(typeof name !== 'string' || !/^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/.test(name))throw Error('registryTable must be an explicitly reviewed schema.table');
  return name.split('.').map(x=>'"'+x+'"').join('.');
};
const hashPattern = /^[a-f0-9]{64}$/;
function readRegular(path) {
  const absolute=resolve(path);let current=sep;
  for(const part of absolute.split(sep).filter(Boolean)) {current=join(current,part);if(lstatSync(current).isSymbolicLink())throw Error('Symlink refused: '+current);}
  if(!lstatSync(absolute).isFile())throw Error('Regular file required');
  const fd=openSync(absolute,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{return readFileSync(fd);}finally{closeSync(fd);}
}
/** Lex only top-level statement boundaries; strings, dollar bodies and nested comments stay opaque. */
function statements(text) {
  let i=0,start=0,words='',result=[];
  while(i<text.length) {
    if(text.startsWith('--',i)){words+=' ';const n=text.indexOf('\n',i+2);i=n<0?text.length:n;continue;}
    if(text.startsWith('/*',i)){words+=' ';let depth=1;i+=2;while(depth&&i<text.length){if(text.startsWith('/*',i)){depth++;i+=2;}else if(text.startsWith('*/',i)){depth--;i+=2;}else i++;}if(depth)throw Error('Unclosed SQL comment');continue;}
    const c=text[i];
    if(c==='\''||c==='"') {
      const escaped=c==='\''&&/[eE]/.test(text[i-1]??'')&&!/[a-zA-Z0-9_]/.test(text[i-2]??'');
      i++;let closed=false;while(i<text.length){if(escaped&&text[i]==='\\'){i+=2;continue;}if(text[i]===c){if(text[i+1]===c){i+=2;continue;}i++;closed=true;break;}i++;}if(!closed)throw Error('Unclosed SQL string');words+=' ? ';continue;
    }
    if(c==='$') {const tag=text.slice(i).match(/^\$(?:[a-zA-Z_][a-zA-Z0-9_]*)?\$/)?.[0];if(tag){const end=text.indexOf(tag,i+tag.length);if(end<0)throw Error('Unclosed SQL dollar body');i=end+tag.length;words+=' ? ';continue;}}
    if(c===';'){if(words.trim())result.push({words:words.trim().toUpperCase(),start,end:i+1});start=i+1;words='';i++;continue;}
    words+=c;i++;
  }
  if(words.trim())result.push({words:words.trim().toUpperCase(),start,end:i});
  return result;
}
function sqlBody(bytes, owner) {
  const sql=new TextDecoder('utf-8',{fatal:true}).decode(bytes), parts=statements(sql);
  let body=parts;
  if(owner==='artifact') {
    if(parts.length<2 || !/^BEGIN(?:\s+TRANSACTION)?$/.test(parts[0].words)||!/^COMMIT(?:\s+TRANSACTION)?$/.test(parts.at(-1).words))throw Error('Artifact requires exact plain BEGIN/COMMIT wrapper');
    body=parts.slice(1,-1);
  }
  for(const part of body)if(/^(?:BEGIN|START\s+TRANSACTION|COMMIT|END\b|ROLLBACK|ABORT|SAVEPOINT|RELEASE\b|PREPARE\s+TRANSACTION|SET\s+(?:SESSION\s+)?TRANSACTION|SET\s+SESSION\s+CHARACTERISTICS|VACUUM|DISCARD|COPY\b|CREATE\s+DATABASE|DROP\s+DATABASE|ALTER\s+SYSTEM)\b/.test(part.words))throw Error('Unsafe transaction/session SQL control');
  if(owner==='artifact')return sql.slice(parts[0].end,parts.at(-1).start);
  return sql;
}
async function refuseExistingDDL(client,body) {
  const created=new Set();
  for(const part of statements(body)) {
    const create=part.words.match(/^CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX|SEQUENCE|VIEW|MATERIALIZED\s+VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Z_][A-Z0-9_$]*(?:\.[A-Z_][A-Z0-9_$]*)?)(?:\s|\(|$)/);
    if(create) {
      let name=create[1].toLowerCase();
      if(!name.includes('.') && /^CREATE\s+(?:UNIQUE\s+)?INDEX\b/.test(part.words)) {
        const target=part.words.match(/\sON\s+(?:ONLY\s+)?([A-Z_][A-Z0-9_$]*)\.[A-Z_][A-Z0-9_$]*/);
        if(target)name=target[1].toLowerCase()+'.'+name;
      }
      const qualified=name.includes('.')?name:'public.'+name;
      if(created.has(qualified))throw Error('Repeated DDL object in artifact: '+qualified);created.add(qualified);
      if((await client.query('SELECT pg_catalog.to_regclass($1)::text AS existing',[qualified])).rows[0]?.existing)throw Error('Unregistered existing DDL object: '+name);
    } else if(/^CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX|SEQUENCE|VIEW|MATERIALIZED\s+VIEW)\b/.test(part.words))throw Error('Unsupported DDL object syntax; explicit owner process required');
    const alter=part.words.match(/^ALTER\s+TABLE\s+([A-Z_][A-Z0-9_$]*(?:\.[A-Z_][A-Z0-9_$]*)?)\s+ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?([A-Z_][A-Z0-9_$]*)/);
    if(alter&&!['CONSTRAINT','PRIMARY','FOREIGN','UNIQUE','CHECK'].includes(alter[2])) {
      const relation=alter[1].toLowerCase(), column=alter[2].toLowerCase();
      if((await client.query('SELECT 1 AS present FROM pg_catalog.pg_attribute WHERE attrelid=pg_catalog.to_regclass($1) AND attname=$2 AND NOT attisdropped',[relation.includes('.')?relation:'public.'+relation,column])).rows.length)throw Error('Unregistered existing DDL column: '+relation+'.'+column);
    }
  }
}
function inputs(options) {
  if(!hashPattern.test(options.expectedManifestSha256??''))throw Error('Reviewed expectedManifestSha256 required');
  const manifestBytes=readRegular(options.manifestPath);
  if(sha256(manifestBytes)!==options.expectedManifestSha256)throw Error('Manifest digest changed');
  const manifest=parseUniqueJson(manifestBytes), snapshots=[{path:options.manifestPath,sha256:sha256(manifestBytes)}], inventory=[], sql=new Map();
  const preliminary=planReconciliation({manifest,inventory:[],registry:{format:1,exportedBy:'owner-connection',databaseRefs:{application:'application','isolated-calendar-only':'calendar'},records:[]}});
  if(preliminary.blockedIssues.some(x=>x.code!=='missing-sql-content'))throw Error('Invalid canonical manifest');
  for(const m of [...manifest.application,manifest.separateSimulator]) {
    const row={id:m.id,database:m.database,sourcePath:m.sourcePath,canonicalPath:m.canonicalPath};
    for(const [path,key] of [[m.sourcePath,'sourceSha256'],...(m.canonicalPath?[[m.canonicalPath,'canonicalSha256']]:[])]) {
      if(!safeRelativePath(path))throw Error('Unsafe SQL path');
      const full=join(resolve(options.sqlRoot),path), bytes=readRegular(full), hash=sha256(bytes);snapshots.push({path:full,sha256:hash});row[key]=hash;
      if(hash!==m.sha256)throw Error('SQL digest changed: '+m.id);
      if(path===m.sourcePath)sql.set(m.id,bytes);
    }
    inventory.push(row);
  }
  return {manifest,inventory,sql,snapshots};
}
function unchanged(input) {for(const s of input.snapshots)if(sha256(readRegular(s.path))!==s.sha256)throw Error('Input changed: '+s.path);}
async function identity(client,expected) {
  const actual=(await client.query(IDENTITY_SQL)).rows[0];
  const pid=(await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  if(backendPids.has(client)&&backendPids.get(client)!==pid)throw Error('Pinned backend changed');
  const keys=['systemIdentifier','databaseName','databaseOid','currentUser'];
  if(!expected || !keys.every(k=>typeof expected[k]==='string'&&expected[k]===actual[k])||Object.keys(expected).some(k=>!keys.includes(k)))throw Error('Current database identity mismatch');
  return actual;
}
function registryDigest(rows) {return sha256(stable([...rows].sort((a,b)=>stable(a).localeCompare(stable(b)))));}
async function inspect(options,input,table) {
  const currentIdentity=await identity(options.client,options.expectedIdentity);
  const rows=(await options.client.query(`SELECT id, database, sha256, state FROM ${table}`)).rows;
  if(rows.some(row=>row.database!==options.database))throw Error('Authoritative registry contains rows for a different physical database');
  const registry={format:1,exportedBy:'pinned-native-owner-session',databaseRefs:{application:'application','isolated-calendar-only':'calendar'},records:rows};
  // The two databases are intentionally independent. Never treat supplied remote records as applied evidence.
  const comparison=planReconciliation({manifest:input.manifest,inventory:input.inventory,registry});
  const actions=[];
  for(const p of comparison.reconciliationProposals.filter(x=>x.database===options.database))actions.push({...p,kind:'adoptAlias'});
  for(const p of comparison.pendingMigrations.filter(x=>x.database===options.database)) {
    if(p.transactionOwner==='owner-existing-process'){comparison.blockedIssues.push({code:'owner-existing-process-required',id:p.id});continue;}
    await refuseExistingDDL(options.client,sqlBody(input.sql.get(p.id),p.transactionOwner));actions.push({kind:'execute',...p});
  }
  unchanged(input);
  return {readOnly:true,deploymentAccepted:false,contextSha256:contextDigest(options),identity:currentIdentity,manifestSha256:options.expectedManifestSha256,registrySha256:registryDigest(rows),actions,blockedIssues:comparison.blockedIssues,appliedMigrations:comparison.appliedMigrations.filter(x=>x.database===options.database)};
}
async function session(options, operation) {
  const {client}=options;
  if(!client||typeof client.query!=='function'||active.has(client))throw Error('An exclusive dedicated connected native client is required');
  if(!['application','isolated-calendar-only'].includes(options.database))throw Error('Explicit database scope required');
  if(typeof options.lockKey!=='string'||! /^-?\d+$/.test(options.lockKey))throw Error('Reviewed shared advisory lockKey required');
  const table=identifier(options.registryTable);active.add(client);let locked=false,pid;
  try {
    // BEGIN would silently nest on an already-open transaction: reject it using backend xact_start.
    const state=(await client.query('SELECT pg_backend_pid() AS pid, xact_start = query_start AS idle FROM pg_catalog.pg_stat_activity WHERE pid=pg_backend_pid()')).rows[0];
    if(!state?.idle)throw Error('Dedicated session must be idle outside a transaction');pid=state.pid;backendPids.set(client,pid);
    await client.query('SELECT pg_advisory_lock($1::bigint)',[options.lockKey]);locked=true;
    const result=await operation(table);
    const after=(await client.query('SELECT pg_backend_pid() AS pid')).rows[0];if(after.pid!==pid)throw Error('Pinned backend changed');
    return result;
  } finally {
    try{await client.query('ROLLBACK');}finally{if(locked)await client.query('SELECT pg_advisory_unlock($1::bigint)',[options.lockKey]);active.delete(client);backendPids.delete(client);}
  }
}
/** Default API: only a read-only PostgreSQL transaction, no registry or schema mutations. */
export async function planAdoption(options) {
  return session(options,async table=>{
    await options.client.query('BEGIN READ ONLY');
    const input=inputs(options), result=await inspect(options,input,table);
    await options.client.query('COMMIT');return result;
  });
}
/** Explicit owner authorization binds the exact ordered plan and complete authoritative registry digest. */
export async function applyAdoption(options) {
  if(options.expectedContextSha256!==contextDigest(options))throw Error('Approved execution context changed');
  if(options.authorize!==true||!hashPattern.test(options.expectedRegistrySha256??'')||!Array.isArray(options.approvedActions))throw Error('Explicit owner authorize, registry digest and approvedActions required');
  return session(options,async table=>{
    const input=inputs(options), completed=[];
    // Each migration retains its own transaction. The session advisory lock survives each COMMIT.
    let expectedDigest=options.expectedRegistrySha256;
    for(let index=0;index<=options.approvedActions.length;index++) {
      const approved=options.approvedActions[index];
      let commitSql='COMMIT';
      if(approved?.kind==='execute' && approved.transactionOwner==='artifact') {
        const bytes=input.sql.get(approved.id);if(!bytes)throw Error('Unknown approved artifact');
        sqlBody(bytes,'artifact');const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes), parts=statements(text);
        await options.client.query(text.slice(0,parts[0].end));commitSql=text.slice(parts.at(-1).start);
      } else await options.client.query('BEGIN');
      await options.client.query(`LOCK TABLE ${table} IN SHARE ROW EXCLUSIVE MODE`);
      const current=await inspect(options,input,table);
      if(current.blockedIssues.length)throw Error('Blocked registry reconciliation: '+stable(current.blockedIssues));
      if(current.registrySha256!==expectedDigest)throw Error('Authoritative registry digest changed; re-plan required');
      const remaining=options.approvedActions.slice(index);
      if(!same(current.actions,remaining))throw Error('Approved ordered actions changed; re-plan required');
      if(index===options.approvedActions.length){await options.client.query('COMMIT');return {...current,readOnly:false,completed};}
      const action=remaining[0];
      unchanged(input);
      if(action.kind==='adoptAlias') {
        const changed=await options.client.query(`UPDATE ${table} SET id=$1 WHERE id=$2 AND database=$3 AND sha256=$4 AND state='applied'`,[action.toId,action.fromId,action.database,action.sha256]);
        if(changed.rowCount!==1)throw Error('Exact alias adoption row changed');
      } else if(action.kind==='execute') {
        await options.client.query('SET LOCAL search_path TO public, pg_catalog');
        await options.client.query('SET LOCAL standard_conforming_strings TO on');
        const body=sqlBody(input.sql.get(action.id),action.transactionOwner);
        await refuseExistingDDL(options.client,body);
        await options.client.query(body);
        await identity(options.client,options.expectedIdentity);unchanged(input);
        await options.client.query(`INSERT INTO ${table} (id,database,sha256,state) VALUES ($1,$2,$3,'applied')`,[action.id,action.database,action.sha256]);
      } else throw Error('Unknown approved action');
      unchanged(input);
      expectedDigest=registryDigest((await options.client.query(`SELECT id, database, sha256, state FROM ${table}`)).rows);
      await options.client.query(commitSql);completed.push(action);
    }
  });
}
