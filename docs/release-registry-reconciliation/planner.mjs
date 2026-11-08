/** Pure, read-only comparison. No registry mutation or SQL execution capability. */
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const nonempty = x => typeof x === 'string' && x.trim().length > 0;
const hash = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const dbs = ['application', 'isolated-calendar-only'];
const key = x => JSON.stringify([x.database, x.id]);
export const safeRelativePath = p => nonempty(p) && !p.includes('\\') && !p.includes('\0') && !p.includes(':') && !p.startsWith('/') && p.split('/').every(s => s && s !== '.' && s !== '..');
export function planReconciliation(input = {}) {
  const {manifest, inventory, registry, scopeDecisions = []} = object(input) ? input : {};
  const result = {readOnly:true, deploymentAccepted:false, pendingMigrations:[], blockedIssues:[], reconciliationProposals:[], appliedMigrations:[], excludedRecords:[]};
  const issue = (code, details = {}) => result.blockedIssues.push({code,...details});
  if (!object(manifest) || manifest.format !== 1 || !Array.isArray(manifest.application) || !manifest.application.length || !object(manifest.separateSimulator) || !object(manifest.identityAliases)) {
    issue('invalid-manifest'); return result;
  }
  const entries = [...manifest.application, manifest.separateSimulator];
  const byId = new Map(), paths = new Set();
  for (const [index,m] of entries.entries()) {
    if (!object(m) || !nonempty(m.id) || !hash(m.sha256) || !['runner','artifact','owner-existing-process'].includes(m.transactionOwner) || !safeRelativePath(m.sourcePath) || (index < manifest.application.length && (!safeRelativePath(m.canonicalPath) || !Array.isArray(m.after) || m.database !== 'application')) || (index === manifest.application.length && (m.database !== 'isolated-calendar-only' || m.canonicalPath !== undefined))) {
      issue('invalid-manifest-entry',{index}); continue;
    }
    if (byId.has(m.id)) issue('duplicate-manifest-id',{id:m.id});
    byId.set(m.id,m);
    for (const p of [m.sourcePath,m.canonicalPath].filter(Boolean)) { if(paths.has(p)) issue('duplicate-manifest-path',{path:p}); paths.add(p); }
  }
  for (const m of byId.values()) {
    if (m.after !== undefined && (!Array.isArray(m.after) || new Set(m.after).size !== m.after.length)) { issue('invalid-dependencies',{id:m.id}); continue; }
    for (const dep of m.after ?? []) if (!nonempty(dep) || !byId.has(dep) || byId.get(dep).database !== m.database) issue('missing-manifest-dependency',{id:m.id,dependency:dep});
  }
  const order = [], visiting = new Set(), visited = new Set();
  const visit = m => { if(visiting.has(m.id)) {issue('dependency-cycle',{id:m.id});return;} if(visited.has(m.id))return; visiting.add(m.id); for(const d of m.after ?? []) if(byId.has(d))visit(byId.get(d)); visiting.delete(m.id);visited.add(m.id);order.push(m); };
  // Validate malformed dependency lists before traversing.
  if(result.blockedIssues.length) return result;
  for (const m of byId.values()) visit(m);
  const aliases = new Map(Object.entries(manifest.identityAliases));
  for(const [alias,target] of aliases) if(!nonempty(alias) || byId.has(alias) || !byId.has(target) || aliases.has(target)) issue('invalid-alias',{alias,target});
  for(const m of byId.values()) if(m.historicalIdentityAliases !== undefined && (!Array.isArray(m.historicalIdentityAliases) || m.historicalIdentityAliases.some(a=>aliases.get(a)!==m.id)))issue('inconsistent-alias-declaration',{id:m.id});
  if(!Array.isArray(inventory))issue('invalid-inventory');
  else {
    const seen = new Set();
    for(const row of inventory) {
      if(!object(row) || !byId.has(row.id) || row.database !== byId.get(row.id).database) {issue('unknown-inventory-entry');continue;}
      const m=byId.get(row.id);
      if(seen.has(row.id))issue('duplicate-inventory-entry',{id:row.id}); seen.add(row.id);
      if(row.sourcePath!==m.sourcePath || row.sourceSha256!==m.sha256 || row.canonicalPath!==m.canonicalPath || (m.canonicalPath && row.canonicalSha256!==m.sha256))issue('sql-content-conflict',{id:m.id});
    }
    for(const m of byId.values())if(!seen.has(m.id))issue('missing-sql-content',{id:m.id});
  }
  if(!object(registry) || registry.format!==1 || !nonempty(registry.exportedBy) || !object(registry.databaseRefs) || !dbs.every(d=>nonempty(registry.databaseRefs[d])) || registry.databaseRefs.application===registry.databaseRefs['isolated-calendar-only'] || !Array.isArray(registry.records))issue('invalid-registry-export');
  if(!Array.isArray(scopeDecisions))issue('invalid-scope-decisions');
  if(result.blockedIssues.length)return result;
  const decisions=new Map();
  for(const d of scopeDecisions) {
    if(!object(d) || !nonempty(d.id) || !dbs.includes(d.database) || !hash(d.sha256) || !nonempty(d.state) || d.decision!=='exclude' || !nonempty(d.reason) || byId.has(d.id) || aliases.has(d.id) || decisions.has(key(d)))issue('invalid-scope-decision');
    else decisions.set(key(d),d);
  }
  const usedDecisions=new Set(), groups=new Map(), rawSeen=new Set(), touched=new Set();
  for(const [index,row] of registry.records.entries()) {
    if(object(row) && nonempty(row.id) && byId.has(aliases.get(row.id)??row.id))touched.add(aliases.get(row.id)??row.id);
    if(!object(row) || !nonempty(row.id) || !dbs.includes(row.database) || !hash(row.sha256) || !nonempty(row.state)) {issue('incomplete-registry-row',{index});continue;}
    if(rawSeen.has(key(row)))issue('duplicate-registry-row',{id:row.id,database:row.database});rawSeen.add(key(row));
    const canonical=aliases.get(row.id)??row.id, m=byId.get(canonical);
    if(!m) {
      if(row.state!=='applied')issue('registry-not-complete',{id:row.id,state:row.state});
      const decision=decisions.get(key(row));
      if(decision && decision.sha256===row.sha256 && decision.state===row.state) {usedDecisions.add(key(row));result.excludedRecords.push({...row,reason:decision.reason});}
      else issue('unknown-registry-id',{id:row.id,database:row.database});
      continue;
    }
    if(row.database!==m.database) {issue('wrong-database',{id:row.id,database:row.database,expected:m.database});continue;}
    const group=groups.get(canonical)??[]; group.push(row);groups.set(canonical,group);
    if(row.sha256!==m.sha256)issue('registry-hash-conflict',{id:row.id,expected:m.sha256,actual:row.sha256});
    if(row.state!=='applied')issue('registry-not-complete',{id:row.id,state:row.state});
  }
  for(const [k,d] of decisions)if(!usedDecisions.has(k))issue('unused-scope-decision',{id:d.id,database:d.database});
  const applied=new Set();
  for(const [id,rows] of groups) {
    if(rows.length!==1)issue('duplicate-canonical-identity',{id,records:rows});
    else if(rows[0].sha256===byId.get(id).sha256 && rows[0].state==='applied')applied.add(id);
  }
  for(const m of order) {
    const rows=groups.get(m.id)??[];
    if(applied.has(m.id)) {
      for(const dependency of m.after??[])if(!applied.has(dependency))issue('applied-dependency-missing',{id:m.id,dependency});
      result.appliedMigrations.push({id:m.id,database:m.database,sha256:m.sha256,recordedId:rows[0].id});
      if(rows[0].id!==m.id)result.reconciliationProposals.push({kind:'replace-alias-identity',database:m.database,fromId:rows[0].id,toId:m.id,sha256:m.sha256,state:'applied',transactionOwner:m.transactionOwner,executeSql:false});
    } else if(!touched.has(m.id))result.pendingMigrations.push({id:m.id,database:m.database,sha256:m.sha256,sourcePath:m.sourcePath,canonicalPath:m.canonicalPath,transactionOwner:m.transactionOwner,after:m.after??[],ready:true});
  }
  // All outputs are advisory. Any conflict fences the whole proposed release.
  if(result.blockedIssues.length) {for(const p of result.pendingMigrations)p.ready=false;result.reconciliationProposals=[];}
  return result;
}
