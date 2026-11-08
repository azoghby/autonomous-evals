import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
export const finalCommit='883d186a94ea38aeb122afeb9d9e9bd2ee0c6e24';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
/** Exact disposable git archive, not a checkout/worktree. No owner files are changed. */
export async function stagePinnedFinal(){
 const archive=mkdtempSync(join(tmpdir(),'rerun-final-input-'));
 execFileSync('tar',['-x','-C',archive],{input:execFileSync('git',['archive',finalCommit],{cwd:root,maxBuffer:256*1024*1024})});
 // The upstream stager runs read-only git object commands relative to its source root.
 // Redirect those to the existing repository; git apply still runs in its disposable output.
 const bin=join(archive,'local-git');mkdirSync(bin);
 const realGit=execFileSync('which',['git'],{encoding:'utf8'}).trim();
 writeFileSync(join(bin,'git'),`#!/usr/bin/env node\nconst {spawnSync}=require('node:child_process');const a=process.argv.slice(2);if(a[0]==='rev-parse'&&a[1]==='--show-toplevel'){process.stdout.write(${JSON.stringify(archive)}+'\\n');process.exit(0);}const ro=['archive','show','cat-file','diff'].includes(a[0]);const r=spawnSync(${JSON.stringify(realGit)},ro?['-C',${JSON.stringify(root)},...a]:a,{stdio:'inherit'});process.exit(r.status??1);\n`,{mode:0o755});
 const oldPath=process.env.PATH;process.env.PATH=bin+':'+oldPath;
 try {const {stageFinal}=await import(pathToFileURL(join(archive,'docs/track-b-final-composition/stage.mjs')).href);return {...stageFinal(),upstreamArchive:archive,finalCommit};}
 finally {process.env.PATH=oldPath;}
}
