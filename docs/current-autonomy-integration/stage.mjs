import {execFileSync as exec} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync as read,writeFileSync as write,mkdirSync,mkdtempSync,existsSync,readdirSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
export const here=dirname(fileURLToPath(import.meta.url));
export const root=resolve(here,'../..');
export const parent='039851736eabb94e85c2c111bbccc78374716275';
export const sha=b=>createHash('sha256').update(b).digest('hex');
export const walk=(d,p='')=>existsSync(d)?readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(join(d,e.name),p+e.name+'/'):[p+e.name]):[];
const git=args=>exec('git',args,{cwd:root,maxBuffer:128*1024*1024});
export function stageCurrent({out,baseline=false}={}) {
 const stage=out?resolve(out):mkdtempSync(join(tmpdir(),'current-autonomy-'));
 if(existsSync(stage)&&readdirSync(stage).length)throw Error('Output must be empty: '+stage);
 mkdirSync(stage,{recursive:true});
 exec('tar',['-x','-C',stage],{input:git(['archive',parent]),maxBuffer:128*1024*1024});
 const paths=git(['ls-tree','-r','--name-only',parent]).toString().trim().split('\n');
 const inventory=Object.fromEntries(paths.map(p=>{const b=read(join(stage,p));return[p,{sha256:sha(b),bytes:b.length}];}));
 const changes={};
 const configPath='apps/web/next.config.ts';
 if(!baseline){
  const before=read(join(stage,configPath),'utf8');
  const anchor='const nextConfig: NextConfig = {\n';
  if(before.split(anchor).length!==2)throw Error('Exact config anchor changed');
  const insert=`  experimental: { extensionAlias: { ".js": [".ts", ".tsx", ".js"] } },
  webpack(config) {
    // Preserve the existing CSS loader when selecting webpack for core ESM imports.
    config.module.rules.push({ oneOf: [{ test: /\\.css$/, exclude: /node_modules/, enforce: "pre", use: [{ loader: "@tailwindcss/turbopack", options: {} }] }] });
    return config;
  },
`;
  const after=before.replace(anchor,anchor+insert);write(join(stage,configPath),after);
  changes[configPath]={preimage:inventory[configPath],sha256:sha(Buffer.from(after)),bytes:Buffer.byteLength(after),reason:'Add ESM extension aliases and preserve current CSS loader for combined webpack/Workflow build; no existing config removed'};
 }
 const additions={};const dependencies=JSON.parse(read(join(here,'DEPENDENCIES.json'))).paths;
 if(!baseline)for(const tree of ['dependencies','source'])for(const p of walk(join(here,tree))){
  const b=read(join(here,tree,p));
  if(inventory[p])throw Error('Current-source collision; no overwrite allowed: '+p);
  if(tree==='dependencies'&&dependencies[p]?.sha256!==sha(b))throw Error('Dependency drift: '+p);
  if(additions[p]&&additions[p].sha256!==sha(b)&&tree!=='source')throw Error('Addition collision: '+p);
  mkdirSync(dirname(join(stage,p)),{recursive:true});write(join(stage,p),b);
  additions[p]={sha256:sha(b),bytes:b.length,origin:tree};
 }
 for(const[p,h]of Object.entries(inventory))if(!changes[p]&&sha(read(join(stage,p)))!==h.sha256)throw Error('Preserved-byte mismatch: '+p);
 const result={parent,stage,baseline,parentFiles:paths.length,parentBytes:Object.values(inventory).reduce((n,h)=>n+h.bytes,0),preservedFiles:paths.length-Object.keys(changes).length,preservedBytes:Object.entries(inventory).filter(([p])=>!changes[p]).reduce((n,[,h])=>n+h.bytes,0),preserved:Object.fromEntries(Object.entries(inventory).filter(([p])=>!changes[p])),changes,additions,releaseAccepted:false,liveRunPerformed:false};
 write(join(stage,'CURRENT-COMPOSITION.json'),JSON.stringify(result,null,2)+'\n');
 return result;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const i=process.argv.indexOf('--out');const r=stageCurrent({out:i<0?undefined:process.argv[i+1],baseline:process.argv.includes('--baseline')});
 console.log(JSON.stringify({stage:r.stage,parent:r.parent,preservedFiles:r.preservedFiles,preservedBytes:r.preservedBytes,additions:Object.keys(r.additions).length}));
}
