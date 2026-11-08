import {readFileSync as read,writeFileSync as write,mkdirSync,existsSync,readdirSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const sha=b=>createHash('sha256').update(b).digest('hex');
const json=p=>JSON.parse(read(p));
const args=process.argv.slice(2);
if(args.length!==4||args[0]!=='--from'||args[2]!=='--out')throw Error('Usage: stage.mjs --from verified-mounted-stage --out empty-directory');
const source=resolve(args[1]),out=resolve(args[3]);
if(source===out||out.startsWith(source+'/')||source.startsWith(out+'/'))throw Error('Separate output required');
if(existsSync(out)&&readdirSync(out).length)throw Error('Output must be empty');
const candidate=json(join(root,'docs/current-chat-mount/CANDIDATE.json'));
const raw=read(join(source,'CURRENT-COMPOSITION.json'));
if(sha(raw)!==candidate.compositionSha256)throw Error('Mounted input inventory does not match reviewed candidate');
const base=JSON.parse(raw),input={...base.preserved,...base.changes,...base.additions};
const safe=p=>typeof p==='string'&&!p.startsWith('/')&&!p.split('/').some(x=>!x||x==='.'||x==='..');
for(const [p,v]of Object.entries(input))if(!safe(p)||sha(read(join(source,p)))!==v.sha256)throw Error('Input drift: '+p);
mkdirSync(out,{recursive:true});
for(const p of Object.keys(input)){mkdirSync(dirname(join(out,p)),{recursive:true});write(join(out,p),read(join(source,p)));}
const applied=[],changed=new Set();
function apply(relative){
 const bytes=read(join(root,relative));
 execFileSync('git',['apply','--check','-'],{cwd:out,input:bytes});
 execFileSync('git',['apply','-'],{cwd:out,input:bytes});
 for(const match of bytes.toString().matchAll(/^\+\+\+ b\/(.+)$/gm)){if(!safe(match[1]))throw Error('Unsafe patch path');changed.add(match[1]);}
 applied.push({path:relative,sha256:sha(bytes)});
}
function supply(pin){
 for(const entry of pin.files){
  const path=join(out,entry.path);
  if(!existsSync(path)){const bytes=read(join(root,entry.path));if(sha(bytes)!==entry.beforeSha256)throw Error('Supplement drift: '+entry.path);mkdirSync(dirname(path),{recursive:true});write(path,bytes);}
  if(sha(read(path))!==entry.beforeSha256)throw Error('Test preimage drift: '+entry.path);
 }
}
function verifyAfter(pin){for(const e of pin.files)if(sha(read(join(out,e.path)))!==e.afterSha256)throw Error('Test postimage drift: '+e.path);}
const calendar=json(join(root,'docs/current-autonomy-calendar/APPLICATION.json'));
if(sha(read(join(root,'docs/current-autonomy-calendar/calendar.patch')))!==calendar.patchSha256)throw Error('Calendar patch drift');
apply('docs/current-autonomy-calendar/calendar.patch');
// Calendar shares this file with the privacy patch. Require that the exact
// publication reauthorization patch is still present after composition.
execFileSync('git',['apply','--reverse','--check','-'],{cwd:out,input:read(join(root,'docs/chat-current-authority/authority/0002-reauthorize-publication.patch'))});
for(const [directory,file]of [['current-autonomy-baseline-correction','owner.patch'],['current-company-composition','test-compatibility.patch']]){
 const pin=json(join(root,'docs',directory,directory==='current-company-composition'?'TEST-PIN.json':'PIN.json'));
 if(sha(read(join(root,'docs',directory,file)))!==pin.patchSha256)throw Error('Test patch drift');
 supply(pin);apply('docs/'+directory+'/'+file);verifyAfter(pin);
}
for(const [p,v]of Object.entries(input)){
 const bytes=read(join(out,p)),hash=sha(bytes);
 if(!changed.has(p)&&hash!==v.sha256)throw Error('Unexpected base drift: '+p);
 if(changed.has(p)){
  const kind=Object.hasOwn(base.preserved,p)?'preserved':Object.hasOwn(base.changes,p)?'changes':'additions';
  delete base[kind][p];base[kind==='additions'?'additions':'changes'][p]={sha256:hash,bytes:bytes.length,reason:'Explicit combined Calendar/test patch'};
 }
}
base.stage=out;
write(join(out,'CURRENT-COMPOSITION.json'),JSON.stringify(base,null,2)+'\n');
const payment=json(join(root,'docs/current-autonomy-payment-startup/APPLICATION.json'));
apply('docs/current-autonomy-payment-startup/application.patch');
for(const [p,v]of Object.entries({...payment.changes,...payment.additions}))if(sha(read(join(out,p)))!==v.sha256)throw Error('Payment postimage drift: '+p);
write(join(out,'PAYMENT-COMPOSITION.json'),JSON.stringify(payment,null,2)+'\n');
const paths=new Set([...Object.keys(input),...changed]);
const final=Object.fromEntries([...paths].sort().map(p=>[p,{sha256:sha(read(join(out,p))),bytes:read(join(out,p)).length}]));
const result={stage:out,parent:base.parent,inputInventorySha256:sha(raw),patches:applied,files:final,releaseAccepted:false,liveRunPerformed:false};
write(join(out,'COMPANY-COMPOSITION.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({stage:out,files:paths.size,patches:applied.length,releaseAccepted:false}));
