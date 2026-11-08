import React from 'react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {JobPrivateChat} from './job-private-chat';
const reply=(text='Persisted checks remain inconclusive.')=>({text,asOf:'2026-11-07T12:00:00Z',unknowns:['Completion time is unknown.']});
const exchange=(text='Saved private answer')=>({messageId:'saved-answer',sequence:1,reply:reply(text)});
const ok=(body:unknown)=>Promise.resolve({ok:true,status:200,json:async()=>body});
const page=(text?:string)=>({exchanges:text?[exchange(text)]:[],nextAfterSequence:text?1:0,hasMore:false});
const poll=()=>({cursor:'a'.repeat(64),changed:true,reply:reply()});
let fetcher:ReturnType<typeof vi.fn>;
beforeEach(()=>{fetcher=vi.fn((url:string)=>ok(url.includes('mode=poll')?poll():page()));vi.stubGlobal('fetch',fetcher);});
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.useRealTimers();});
const flush=async()=>act(async()=>{await Promise.resolve();await Promise.resolve();});

it('announces initial loading and never invents progress before a response',async()=>{
 let resolveHistory!:(r:unknown)=>void;
 fetcher.mockImplementation((url:string)=>url.includes('mode=poll')?new Promise(()=>{}):new Promise(r=>resolveHistory=r));
 render(<JobPrivateChat jobId="owned/id"/>);
 expect(screen.getByText('Loading private history…').getAttribute('role')).toBe('status');
 expect(screen.queryByLabelText('Latest persisted progress')).toBeNull();
 expect(screen.queryByText(/No answers yet/)).toBeNull();
 await act(async()=>{resolveHistory({ok:true,json:async()=>page()});});
 expect(screen.getByText(/No answers yet/)).toBeTruthy();
 expect(fetcher.mock.calls.every(([url,init])=>url.startsWith('/api/jobs/owned%2Fid/chat')&&init.cache==='no-store'&&init.credentials==='same-origin')).toBe(true);
});
it('exposes native keyboard form controls, visible focus styles and private guidance',async()=>{
 render(<JobPrivateChat jobId="owned-job"/>);await screen.findByText(/No answers yet/);
 const input=screen.getByRole('textbox',{name:'Ask about this evaluation'}) as HTMLTextAreaElement;
 const submit=screen.getByRole('button',{name:'Send question'}) as HTMLButtonElement;
 expect(submit.type).toBe('submit');expect(submit.disabled).toBe(true);
 expect(input.getAttribute('aria-describedby')).toBeTruthy();
 expect(document.getElementById(input.getAttribute('aria-describedby')!)?.textContent).toMatch(/Do not include API keys/);
 input.focus();expect(document.activeElement).toBe(input);
 fireEvent.change(input,{target:{value:'What is recorded?'}});
 expect(submit.disabled).toBe(false);expect(submit.className).toContain('focus-visible:outline');
 // jsdom has no browser default Enter-to-click action. Dispatch the resulting native form submit.
 fetcher.mockImplementation((url:string,init:RequestInit)=>init.method==='POST'?ok({exchange:{...exchange(),messageId:JSON.parse(String(init.body)).messageId}}):ok(url.includes('mode=poll')?poll():page()));
 submit.focus();expect(document.activeElement).toBe(submit);fireEvent.submit(submit.closest('form')!);
 await screen.findByText('Saved private answer');
 expect(fetcher.mock.calls.filter(([,init])=>init.method==='POST')).toHaveLength(1);
});
it('reports safe loading failure, retries history and never renders server error payloads',async()=>{
 fetcher.mockImplementation((url:string)=>url.includes('mode=poll')?ok(poll()):Promise.resolve({ok:false,status:503,json:async()=>({error:'secret server trace'})}));
 render(<JobPrivateChat jobId="owned-job"/>);
 await screen.findByText('Private chat is temporarily unavailable. Try again.');
 expect(screen.queryByText('secret server trace')).toBeNull();
 fetcher.mockImplementation((url:string)=>ok(url.includes('mode=poll')?poll():page('Restored persisted answer')));
 fireEvent.click(screen.getByRole('button',{name:'Retry history'}));await screen.findByText('Restored persisted answer');
});
it('erases loaded answers, progress and drafts after revocation and rejects a stale send',async()=>{
 vi.useFakeTimers();let denied=false;let resolveSend!:(v:unknown)=>void;let messageId='';
 fetcher.mockImplementation((url:string,init:RequestInit)=>{
  if(init.method==='POST'){messageId=JSON.parse(String(init.body)).messageId;return new Promise(r=>resolveSend=r);}
  return denied?Promise.resolve({ok:false,status:401}):ok(url.includes('mode=poll')?poll():page('Before revocation'));
 });
 render(<JobPrivateChat jobId="owned-job"/>);await flush();
 fireEvent.change(screen.getByLabelText('Ask about this evaluation'),{target:{value:'Private draft'}});
 fireEvent.click(screen.getByRole('button',{name:'Send question'}));
 denied=true;await act(async()=>{await vi.advanceTimersByTimeAsync(10_000);});
 expect(screen.queryByText('Before revocation')).toBeNull();expect(screen.queryByText('Persisted checks remain inconclusive.')).toBeNull();
 expect((screen.getByLabelText('Ask about this evaluation') as HTMLTextAreaElement).value).toBe('');
 expect(screen.getByText('Sign in again to read your private chat.')).toBeTruthy();
 await act(async()=>{resolveSend({ok:true,json:async()=>({exchange:{...exchange('Stale sent answer'),messageId}})});});
 expect(screen.queryByText('Stale sent answer')).toBeNull();
});
it('drops stale history and progress when the job binding changes',async()=>{
 const deferred:((v:unknown)=>void)[]=[];
 fetcher.mockImplementation((url:string)=>url.includes('/job-a/')?new Promise(r=>deferred.push(r)):ok(url.includes('mode=poll')?poll():page('Current job answer')));
 const view=render(<JobPrivateChat jobId="job-a"/>);
 fireEvent.change(screen.getByLabelText('Ask about this evaluation'),{target:{value:'Job A draft'}});
 view.rerender(<JobPrivateChat jobId="job-b"/>);await screen.findByText('Current job answer');
 await act(async()=>{deferred.forEach(r=>r({ok:true,json:async()=>({...page('Wrong job answer'),...poll(),reply:reply('Wrong job progress')})}));});
 expect(screen.queryByText('Wrong job answer')).toBeNull();expect(screen.queryByText('Wrong job progress')).toBeNull();
 expect((screen.getByLabelText('Ask about this evaluation') as HTMLTextAreaElement).value).toBe('');
});
it('retains responsive wrapping primitives for long content without fixed chat width',async()=>{
 fetcher.mockImplementation((url:string)=>ok(url.includes('mode=poll')?{...poll(),reply:reply('x'.repeat(1000))}:page()));
 const {container}=render(<JobPrivateChat jobId="owned-job"/>);await screen.findByText('x'.repeat(1000));
 expect(screen.getByText('x'.repeat(1000)).className).toContain('break-words');
 expect(screen.getByRole('textbox').className).toContain('w-full');
 expect(screen.getByRole('button',{name:'Send question'}).parentElement?.className).toContain('flex-wrap');
 expect(container.querySelector('.sm\\:p-6')).toBeTruthy();
});
