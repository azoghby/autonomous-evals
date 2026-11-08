import {createRequire} from 'node:module';
import {readFileSync,writeFileSync,mkdirSync,cpSync,realpathSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const here=dirname(fileURLToPath(import.meta.url)),artifact=resolve(here,'..');
const stage=realpathSync(process.env.EXPERT_REVIEW_STAGE??'/tmp/expert-review-api-stage');
const require=createRequire(join(stage,'package.json'));
const {createServer}=await import(pathToFileURL(require.resolve('vite')));
const {chromium}=require('@playwright/test');
const {compile}=require('@tailwindcss/node'),{Scanner}=require('@tailwindcss/oxide');
const fixture=join(stage,'review-interface-fixture');mkdirSync(fixture,{recursive:true});
const cssPath=join(stage,'apps/web/src/app/globals.css');
const compiler=await compile(readFileSync(cssPath,'utf8'),{base:dirname(cssPath),onDependency:()=>{}});
const scanner=new Scanner({sources:[{base:join(stage,'apps/web/src'),pattern:'**/*.{tsx,ts}',negated:false}]});
let css=compiler.build(scanner.scan());
const oldCss=readFileSync('/tmp/naive-rich-runtime-buCIBn/apps/web/.next/static/css/4556621e9737032e.css','utf8');
css+=(oldCss.match(/@font-face\{[^}]+\}/g)??[]).join('').replaceAll('/_next/static/media/','/fonts/');
css+=':root{--font-display:Geist;--font-mono-face:"Geist Mono";}';
writeFileSync(join(fixture,'styles.css'),css);
cpSync('/tmp/naive-rich-runtime-buCIBn/apps/web/.next/static/media',join(fixture,'fonts'),{recursive:true});
writeFileSync(join(fixture,'index.html'),'<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Local review interface fixture</title></head><body><div style="max-width:1280px;margin:auto;padding:24px"><p style="color:#94979e;font-size:12px;margin-bottom:24px">Local interface fixture. No real review session or provider calls.</p><div id="root"></div></div><script type="module" src="/main.tsx"></script></body></html>');
writeFileSync(join(fixture,'main.tsx'),`import React from 'react';import{createRoot}from'react-dom/client';import{ExpertReviewQueue}from'@/components/app/expert-review-queue';import'./styles.css';createRoot(document.getElementById('root')!).render(<ExpertReviewQueue/>);`);
const server=await createServer({root:fixture,configFile:false,define:{'process.env':JSON.stringify({NODE_ENV:'development'})},resolve:{alias:{'@':join(stage,'apps/web/src'),'@ae/core':join(stage,'packages/core/src')}},server:{host:'127.0.0.1',port:0,fs:{allow:[stage,artifact]}},oxc:{jsx:{runtime:'automatic'}}});
await server.listen();const address=server.httpServer.address(),origin=`http://127.0.0.1:${address.port}`;
const fixtureModule=await server.ssrLoadModule(join(here,'fixtures.ts'));
const contribution=fixtureModule.contribution,corpus=fixtureModule.corpus;
const browser=await chromium.launch({headless:true,executablePath:process.env.REVIEW_CHROMIUM_PATH??join(process.env.HOME,'Library/Caches/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell')});
const receipts=[],errors=[];let saved=[];let retained=false,pagination=false;
const fixtureCursor=Buffer.from(JSON.stringify([contribution.jobId,'expert-review-candidate:'+ '0'.repeat(64)])).toString('base64url');
try{
 const page=await browser.newPage();page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/operator/expert-reviews**',async route=>{
  const request=route.request(),url=new URL(request.url());
  if(request.method()==='POST'){saved.push(request.postDataJSON());retained=true;return route.fulfill({json:{status:'recorded'}});}
  if(url.pathname==='/api/operator/expert-reviews'){const candidates=pagination?(url.searchParams.has('cursor')?[corpus]:[]):retained?[]:[contribution,corpus];return route.fulfill({json:{items:candidates.map(({snapshot,snapshotDigest,principalId,...item})=>item),truncated:pagination&&!url.searchParams.has('cursor'),nextCursor:pagination&&!url.searchParams.has('cursor')?fixtureCursor:null}});}
  return route.fulfill({json:url.pathname.includes('/contribution/')?contribution:corpus});
 });
 await page.setViewportSize({width:1440,height:1000});await page.goto(origin);await page.getByRole('button',{name:/Expert contribution/}).click();
 await page.getByRole('heading',{name:'Exact expected answer'}).waitFor();
 if(!await page.getByRole('button',{name:'Record contribution review'}).isDisabled())throw Error('Default approval enabled');
 mkdirSync(join(artifact,'evidence'),{recursive:true});
 await page.screenshot({path:join(artifact,'evidence/desktop-contribution.png'),fullPage:true});
 for(const name of [/verified the retained qualification/,/verified informed consent/,/independent of the target/,/reviewed this exact immutable/])await page.getByRole('checkbox',{name}).check();
 await page.getByRole('combobox',{name:'Answer decision case'}).selectOption('approved');
 await page.getByLabel('Independent rationale · case').fill('Verified against the exact retained evidence and consent.');
 await page.getByRole('checkbox',{name:'Source source',exact:true}).check();
 await page.getByRole('button',{name:'Record contribution review'}).click();
 await page.getByRole('status').filter({hasText:'Review recorded'}).waitFor();
 if(saved.length!==1||saved[0].snapshotDigest!==contribution.snapshotDigest||saved[0].review.approvedAnswers[0].exactAnswer!==contribution.snapshot.contribution.cases[0].expectedAnswer)throw Error('Submission binding failed');
 receipts.push('Desktop: no preselected approval; explicit consent/qualification/independence/exact answer/evidence submission recorded once.');
 retained=false;pagination=true;await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.getByRole('button',{name:'Load next page',exact:true}).click();await page.getByRole('button',{name:/Candidate corpus/}).waitFor();receipts.push('Cursor pagination reaches a valid later snapshot after an empty omitted first page.');await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:/Candidate corpus/}).click();
 await page.getByRole('combobox',{name:'Corpus decision',exact:true}).waitFor();
 await page.screenshot({path:join(artifact,'evidence/mobile-corpus.png'),fullPage:true});
 const widths=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,viewport:innerWidth}));
 if(widths.scroll>widths.viewport)throw Error(`Mobile overflow ${JSON.stringify(widths)}`);
 // Stale authority response must discard the private detail and prevent further submission.
 await page.unroute('**/api/operator/expert-reviews**');
 await page.route('**/api/operator/expert-reviews**',route=>route.fulfill({status:403,json:{error:'Operator authorization changed'}}));
 await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.getByText('Operator authorization changed',{exact:true}).waitFor();
 if(await page.getByText('Exact expected answer',{exact:true}).count())throw Error('Revoked private detail retained');
 receipts.push('Mobile: 390px viewport has no horizontal overflow; revoked authorization removes private detail.');
 if(errors.length)throw Error(errors.join('; '));
 writeFileSync(join(artifact,'evidence/browser.json'),JSON.stringify({fixture:true,hosted:false,providerCalls:false,desktop:{width:1440,height:1000},mobile:{width:390,height:844},receipts,consoleErrors:errors},null,2)+'\n');
 console.log(receipts.join('\n'));
}finally{await browser.close();await server.close();}
