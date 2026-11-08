#!/usr/bin/env node
import {readFileSync, lstatSync, openSync, closeSync, constants, realpathSync} from 'node:fs';
import {resolve, join, relative, sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {planReconciliation, safeRelativePath} from './planner.mjs';
import {parseUniqueJson} from './strict-json.mjs';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

/** All reads are local. Refuse symlinks, nonregular files, and path traversal. */
export function reconcileFiles({manifestPath, sqlRoot, registryPath, scopeDecisionsPath}) {
  const snapshots = [];
  function readRegular(path) {
    const absolute=resolve(path);
    // Check each component, including ancestors of explicitly supplied input files.
    const parts=absolute.split(sep).filter(Boolean); let current=sep;
    for(const part of parts) {current=join(current,part);if(lstatSync(current).isSymbolicLink())throw Error('Symlink refused: '+current);}
    if(!lstatSync(absolute).isFile())throw Error('Regular file required: '+absolute);
    const fd=openSync(absolute,constants.O_RDONLY | constants.O_NOFOLLOW);
    try {const bytes=readFileSync(fd);snapshots.push({path:absolute,sha256:digest(bytes)});return bytes;} finally {closeSync(fd);}
  }
  const manifestBytes=readRegular(manifestPath), registryBytes=readRegular(registryPath);
  const scopeBytes=scopeDecisionsPath?readRegular(scopeDecisionsPath):undefined;
  const manifest=parseUniqueJson(manifestBytes), registry=parseUniqueJson(registryBytes);
  const scopeDecisions=scopeBytes?parseUniqueJson(scopeBytes):[];
  const root=resolve(sqlRoot);
  if(lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory())throw Error('SQL root must be a real directory');
  const realRoot=realpathSync(root);
  const sqlRead = p => {
    if(!safeRelativePath(p))throw Error('Unsafe manifest SQL path: '+String(p));
    const target=resolve(root,p), rel=relative(realRoot,target);
    if(rel==='..' || rel.startsWith('..'+sep) || resolve(realRoot,rel)!==target)throw Error('SQL path escapes root');
    return readRegular(target);
  };
  let inventory=[];
  // Validate metadata first so malformed manifests produce structured blocked output.
  const preliminary=planReconciliation({manifest,inventory:[],registry,scopeDecisions});
  if(preliminary.blockedIssues.every(i=>i.code==='missing-sql-content')) {
    inventory=[...manifest.application,manifest.separateSimulator].map(m=>({id:m.id,database:m.database,sourcePath:m.sourcePath,canonicalPath:m.canonicalPath,sourceSha256:digest(sqlRead(m.sourcePath)),...(m.canonicalPath?{canonicalSha256:digest(sqlRead(m.canonicalPath))}:{})}));
  }
  const plan=planReconciliation({manifest,inventory,registry,scopeDecisions});
  // Fence edits observed during this read-only run; no normalization or writes.
  for(const s of [...snapshots])if(digest(readRegular(s.path))!==s.sha256)throw Error('Input changed during comparison: '+s.path);
  return {...plan,inputEvidence:{manifestSha256:digest(manifestBytes),registrySha256:digest(registryBytes),...(scopeBytes?{scopeDecisionsSha256:digest(scopeBytes)}:{}),sqlRoot:realRoot,files:snapshots.slice(0,snapshots.length/2)},requiresExclusiveOwnerLockRevalidation:true};
}
export function main(argv=process.argv.slice(2)) {
  try {
    const names={'--manifest':'manifestPath','--sql-root':'sqlRoot','--registry':'registryPath','--scope-decisions':'scopeDecisionsPath'}, options={};
    if(argv.length===1 && argv[0]==='--help') {console.log('Read-only: node cli.mjs --manifest FILE --sql-root DIRECTORY --registry FILE [--scope-decisions FILE]');return 0;}
    for(let i=0;i<argv.length;i+=2) {
      if(!Object.hasOwn(names,argv[i]) || !argv[i+1] || argv[i+1].startsWith('--') || options[names[argv[i]]])throw Error('Invalid, missing, or repeated argument: '+argv[i]);
      options[names[argv[i]]]=argv[i+1];
    }
    if(!options.manifestPath || !options.sqlRoot || !options.registryPath)throw Error('Required: --manifest FILE --sql-root DIRECTORY --registry FILE');
    const result=reconcileFiles(options);console.log(JSON.stringify(result,null,2));return result.blockedIssues.length?2:0;
  } catch(error) {console.error(JSON.stringify({readOnly:true,deploymentAccepted:false,error:error.message}));return 1;}
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href)process.exitCode=main();
