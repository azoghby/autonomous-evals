/** Local packaging only: copies reviewed SQL into a NEW directory. No staging subprocesses. */
import {readFileSync,writeFileSync,mkdirSync,lstatSync} from 'node:fs';
import {resolve,dirname,join,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {parseUniqueJson} from '../release-registry-reconciliation/strict-json.mjs';
const here=dirname(fileURLToPath(import.meta.url));
const hash=b=>createHash('sha256').update(b).digest('hex');
function read(path){let cur=sep;for(const part of resolve(path).split(sep).filter(Boolean)){cur=join(cur,part);if(lstatSync(cur).isSymbolicLink())throw Error('Symlink refused');}if(!lstatSync(path).isFile())throw Error('Regular SQL required');return readFileSync(path);}
export function composeSqlRoot({reviewedStage,output}) {
  const pin=parseUniqueJson(read(join(here,'PIN.json'))),bytes=read(join(here,'MIGRATIONS.json'));
  if(hash(bytes)!==pin.manifestSha256)throw Error('Manifest pin changed');
  const manifest=parseUniqueJson(bytes),files=new Map();
  for(const m of [...manifest.application,manifest.separateSimulator]){
    const extra=m.sourcePath.startsWith('docs/migration-registry-adoption/sql/');
    const bytes=read(extra?join(here,'sql',m.sourcePath.split('/').at(-1)):join(resolve(reviewedStage),m.sourcePath));
    if(hash(bytes)!==m.sha256)throw Error('SQL digest mismatch: '+m.id);
    files.set(m.sourcePath,bytes);if(m.canonicalPath)files.set(m.canonicalPath,bytes);
  }
  // Exclusive mkdir: refuse an existing destination; never overlay an owner app.
  mkdirSync(resolve(output));
  for(const [path,bytes] of files){const target=join(resolve(output),path);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,bytes,{flag:'wx'});}
  return {sqlRoot:resolve(output),manifestSha256:pin.manifestSha256,files:files.size,applied:false};
}
