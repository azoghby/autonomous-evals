import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const stage=JSON.parse(readFileSync(new URL('./evidence/STAGE.json',import.meta.url))).stage;
const manifest=JSON.parse(readFileSync(join(stage,'owner-migrations/manifest.json')));
const id='app.workflow-finding-reruns.008',entry=manifest.application.find(e=>e.id===id);
assert.deepEqual(entry.after,['app.workflow002','app.workflow-remediation.004','app.workflow-packs.005','app.workflow-resumption.007']);
assert.equal(entry.transactionOwner,'runner');assert.equal(entry.identityReconciliationRequiredIfAliasApplied,true);
assert.deepEqual(entry.historicalIdentityAliases,['app.workflow-finding-reruns.006']);
assert.equal(manifest.identityAliases['app.workflow-finding-reruns.006'],id);
assert.equal(manifest.identityAliases['app.workflow-comparison.006'],'app.rich-comparison.006');
assert.equal(manifest.migrationRenames['apps/web/migrations/006-workflow-finding-reruns.sql'],'apps/web/migrations/008-workflow-finding-reruns.sql');
const bytes=readFileSync(join(stage,entry.sourcePath));assert.deepEqual(bytes,readFileSync(join(stage,entry.canonicalPath)));
assert.equal(createHash('sha256').update(bytes).digest('hex'),'9884992989f6aafb1861708ad426924651f172b90295fb13e8a78e06e1e688e7');
const seen=new Set();for(const m of manifest.application){assert(!seen.has(m.id));for(const dep of m.after)assert(seen.has(dep));seen.add(m.id);}
console.log('Ordered full identities, aliases, transaction ownership, predecessor dependencies and exact SQL bytes verified; no DDL executed.');
