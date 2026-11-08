// Actual Next/React rendered component, explicitly synthetic API, never deployed auth.
import {spawn,execFileSync,spawnSync} from 'node:child_process';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
const here=dirname(fileURLToPath(import.meta.url));
const repo=execFileSync('git',['rev-parse','--show-toplevel'],{cwd:here,encoding:'utf8'}).trim();
const stage=resolve(process.argv[2]);const out=resolve(process.argv[3]??join(repo,'docs/chat-workflow-release/ui/rendered'));
mkdirSync(out,{recursive:true});
const patch=join(repo,'docs/chat-workflow-release/ui/restore-history.patch');
if(spawnSync('git',['apply','--reverse','--check',patch],{cwd:stage}).status!==0){execFileSync('git',['apply','--check',patch],{cwd:stage});execFileSync('git',['apply',patch],{cwd:stage});}
const route=join(stage,'apps/web/src/app/chat-release-fixture');mkdirSync(route,{recursive:true});
writeFileSync(join(route,'page.tsx'),`import {JobPrivateChat} from '@/components/app/job-private-chat';export default function Fixture(){return <main id="main" style={{maxWidth:960,margin:'40px auto',padding:16}}><h1>Local component fixture — synthetic responses</h1><JobPrivateChat jobId="synthetic-owned-job"/></main>}`);
const server=spawn('npm',['exec','-w','web','--','next','dev','--webpack','-p','3217'],{cwd:stage,env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,NEXT_TELEMETRY_DISABLED:'1',NEXT_FONT_GOOGLE_MOCKED_RESPONSES:join(stage,'offline-fonts.cjs'),NODE_OPTIONS:`--require=${join(stage,'offline.cjs')}`},stdio:['ignore','pipe','pipe'],detached:true});
let log='';server.stdout.on('data',d=>log+=d);server.stderr.on('data',d=>log+=d);
let browser;
try{
 for(let i=0;i<120;i++){if(log.includes('Ready in'))break;if(server.exitCode!==null)throw Error(log);await new Promise(r=>setTimeout(r,500));}
 const {chromium}=await import(pathToFileURL(join(stage,'node_modules/playwright-core/index.mjs')));
 browser=await chromium.launch({channel:'chrome',headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:1100}});
 page.on('console',m=>log+='\nBROWSER '+m.type()+': '+m.text());page.on('pageerror',e=>log+='\nPAGEERROR '+e.message);
 const routeChecks=[];const routeErrors=[];
 for(const [method,path,origin,expected] of [
  ['GET','/api/jobs/synthetic-owned-job/chat',null,401],
  ['GET','/api/jobs/synthetic-owned-job/data-review?digest='+ 'a'.repeat(64),null,403],
  ['POST','/api/jobs/synthetic-owned-job/data-review','http://localhost:3217',403],
  ['POST','/api/jobs/synthetic-owned-job/data-review','http://invalid.example',403],
  ['GET','/api/jobs/synthetic-owned-job/chat?mode=poll',null,401],
  ['POST','/api/jobs/synthetic-owned-job/chat','http://localhost:3217',401],
  ['POST','/api/jobs/synthetic-owned-job/chat','http://invalid.example',400],
 ]){
  const r=await page.request.fetch('http://localhost:3217'+path,{method,headers:origin?{origin}:{},data:method==='POST'?{messageId:'local-smoke',text:'progress?'}:undefined,timeout:90000});
  const result={method,path,status:r.status(),cacheControl:r.headers()['cache-control'],vary:r.headers()['vary']};
  routeChecks.push(result);
  if(result.status!==expected||(path.includes('/chat')&&(result.cacheControl!=='private, no-store'||!result.vary?.includes('Cookie'))))routeErrors.push(result);
 }
 writeFileSync(join(out,'actual-routes.json'),JSON.stringify(routeChecks,null,2));
 if(process.argv.includes('--routes-only')){
  if(routeErrors.length)throw Error('Actual route checks failed: '+JSON.stringify(routeErrors));
  console.log('Seven actual anonymous route checks passed; no fixture screenshots repeated.');
 }else{
 const requests=[];let posts=[];let delivered=false;
 const reply=()=>({text:delivered?'Delivered. Confirmed findings remain recorded; evaluation data review is blocked.':'Running. Confirmed finding recorded; waiting for expert review.',asOf:'2026-11-07T12:00:00Z',unknowns:['Final cost is unknown.','Completion time is unknown.']});
 await page.route('**/*',async r=>{
  const url=new URL(r.request().url());
  if(url.hostname!=='localhost'&&url.hostname!=='127.0.0.1')return r.abort();
  if(url.pathname.includes('/api/jobs/')&&url.pathname.endsWith('/chat')){
   requests.push({method:r.request().method(),path:url.pathname,query:url.search});
   if(r.request().method()==='POST'){
    posts.push(r.request().postDataJSON());
    if(posts.length===1)return r.fulfill({status:503,json:{error:'synthetic outage'}});
    return r.fulfill({json:{exchange:{messageId:posts.at(-1).messageId,sequence:1,reply:reply()}}});
   }
   return r.fulfill({json:url.searchParams.get('mode')==='poll'?{cursor:'a'.repeat(64),changed:true,reply:reply()}:{exchanges:[],nextAfterSequence:0,hasMore:false}});
  }
  return r.continue();
 });
 await page.goto('http://localhost:3217/jobs/synthetic-owned-job',{timeout:90000,waitUntil:'domcontentloaded'});
 await page.waitForURL('**/signin**',{timeout:30000});
 await page.goto('http://localhost:3217/sample',{timeout:90000,waitUntil:'domcontentloaded'});
 if(await page.getByRole('heading',{name:'Private progress chat',exact:true}).count())throw Error('Private chat visible on public sample');
 routeChecks.push({anonymousJobRedirect:'signin',publicSampleHasPrivateChat:false});
 writeFileSync(join(out,'actual-routes.json'),JSON.stringify(routeChecks,null,2));
 await page.goto('http://localhost:3217/chat-release-fixture',{timeout:90000,waitUntil:'domcontentloaded'});
 await page.getByText('Running. Confirmed finding recorded; waiting for expert review.',{exact:true}).waitFor();
 const style=await page.locator('section').evaluate(el=>{const c=getComputedStyle(el);return {borderTopWidth:c.borderTopWidth,background:c.backgroundColor,padding:getComputedStyle(el.children[1]).padding,fontFamily:getComputedStyle(document.body).fontFamily};});
 if(style.borderTopWidth!=='1px'||style.padding==='0px')throw Error('Tailwind utility styles missing: '+JSON.stringify(style));
 await page.screenshot({path:join(out,'desktop-running.png'),fullPage:true});
 await page.getByLabel('Ask about this evaluation',{exact:true}).fill('What findings and blockers are recorded?');
 await page.getByRole('button',{name:'Send question',exact:true}).click();
 await page.getByText('Private chat is temporarily unavailable. Try again.',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Retry same question',exact:true}).click();
 await page.getByText('Answer 1',{exact:true}).waitFor();
 if(JSON.stringify(posts[0])!==JSON.stringify(posts[1]))throw Error('Browser retry changed message identity/text');
 delivered=true;await page.waitForTimeout(11000);
 await page.getByText('Delivered. Confirmed findings remain recorded; evaluation data review is blocked.',{exact:true}).waitFor();
 await page.setViewportSize({width:390,height:844});
 await page.screenshot({path:join(out,'mobile-delivered.png'),fullPage:true});
 const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
 if(overflow)throw Error('Mobile horizontal overflow');
 writeFileSync(join(out,'result.json'),JSON.stringify({routeChecks,routeErrors,boundary:'Actual Chromium + Next16.4.5 + React19.3.0, synthetic API fixture; no authenticated session/database/deployment',desktop:[1440,1100],mobile:[390,844],computedStyles:style,stableRetry:posts[0].messageId===posts[1].messageId,mobileOverflow:overflow,requests},null,2));
 if(routeErrors.length)throw Error('Rendered UI checked, but actual routes failed: '+JSON.stringify(routeErrors));
 }
}finally{if(browser)await browser.close();try{process.kill(-server.pid,'SIGTERM');}catch{}writeFileSync(join(out,'next-dev.log'),log);}
