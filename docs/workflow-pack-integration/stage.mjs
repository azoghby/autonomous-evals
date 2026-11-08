import {createHash} from 'node:crypto';
import {execFileSync as exec} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {stageExecution} from './execution/stage.mjs';
const here=dirname(fileURLToPath(import.meta.url)),root=resolve(here,'../..');
export function stagePackSeries(){
 const series=JSON.parse(readFileSync(join(here,'SERIES.json'),'utf8'));
 for(const [file,hash] of Object.entries(series.sha256)){
  if(createHash('sha256').update(readFileSync(join(root,file))).digest('hex')!==hash)throw Error(`Pinned input changed: ${file}`);
 }
 exec('git',['merge-base','--is-ancestor',series.requiresAncestor,series.core],{cwd:root});
 const assembled=stageExecution();
 if(assembled.core!==series.core||assembled.trackA!==series.trackA)throw Error('Stage pin mismatch');
 return {...assembled,patches:series.patches};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(stagePackSeries()));
