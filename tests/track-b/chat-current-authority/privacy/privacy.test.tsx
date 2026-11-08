import React from 'react';
import {afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {JobPrivateChat} from './job-private-chat';
const reply=(text:string)=>({text,asOf:'2026-11-07T12:00:00Z',unknowns:[]});
const exchange=(text:string)=>({messageId:'one',sequence:1,reply:reply(text)});
const ok=(body:unknown)=>Promise.resolve({ok:true,status:200,json:async()=>body});
const page=(text?:string)=>({exchanges:text?[exchange(text)]:[],nextAfterSequence:text?1:0,hasMore:false});
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.useRealTimers();});
it('does not publish old-job history, poll or send after navigation even if transport ignores abort',async()=>{
 let history!:(v:unknown)=>void,poll!:(v:unknown)=>void,post!:(v:unknown)=>void;let id='';
 vi.stubGlobal('fetch',vi.fn((url:string,init:RequestInit)=>{
  if(url.includes('job-b'))return ok(url.includes('mode=poll')?{cursor:'b'.repeat(64),changed:false}:page('B private history'));
  if(init.method==='POST'){id=JSON.parse(String(init.body)).messageId;return new Promise(resolve=>post=resolve);}
  return new Promise(resolve=>url.includes('mode=poll')?poll=resolve:history=resolve);
 }));
 const view=render(<JobPrivateChat jobId="job-a"/>);
 fireEvent.change(screen.getByLabelText('Ask about this evaluation'),{target:{value:'A question'}});
 fireEvent.click(screen.getByRole('button',{name:'Send question'}));
 view.rerender(<JobPrivateChat jobId="job-b"/>);await screen.findByText('B private history');
 await act(async()=>{history(await ok(page('A history')));poll(await ok({cursor:'a'.repeat(64),changed:true,reply:reply('A poll')}));post(await ok({exchange:{...exchange('A post'),messageId:id}}));});
 for(const text of ['A history','A poll','A post'])expect(screen.queryByText(text)).toBeNull();
 expect((screen.getByLabelText('Ask about this evaluation') as HTMLTextAreaElement).value).toBe('');
});
it('renders reply and unknown strings as inert text; evidence references do not become links',async()=>{
 const text='<a href="https://other.example/private-evidence">private evidence</a>';
 vi.stubGlobal('fetch',vi.fn((url:string)=>ok(url.includes('mode=poll')?{cursor:'a'.repeat(64),changed:false}:{...page(),exchanges:[{...exchange(text),evidenceRefs:['https://other.example/secret'],inputDigest:'hidden-digest'}],nextAfterSequence:1})));
 const view=render(<JobPrivateChat jobId="job-a"/>);await screen.findByText(text);
 expect(view.container.querySelectorAll('a,img,script')).toHaveLength(0);
 expect(view.container.textContent).not.toContain('hidden-digest');expect(view.container.textContent).not.toContain('other.example/secret');
});
it('freezes all polling on denial and restarts with empty history/progress cursors',async()=>{
 vi.useFakeTimers();let deny=false;const urls:string[]=[];
 vi.stubGlobal('fetch',vi.fn((url:string)=>{urls.push(url);return deny?Promise.resolve({ok:false,status:404}):ok(url.includes('mode=poll')?{cursor:'a'.repeat(64),changed:true,reply:reply('Private snapshot')}:page('Private history'));}));
 render(<JobPrivateChat jobId="job-a"/>);await act(async()=>{await Promise.resolve();await Promise.resolve();});
 deny=true;await act(async()=>{await vi.advanceTimersByTimeAsync(10_000);});
 expect(screen.queryByText('Private history')).toBeNull();expect(screen.queryByText('Private snapshot')).toBeNull();
 const deniedCount=urls.length;await act(async()=>{await vi.advanceTimersByTimeAsync(30_000);});expect(urls).toHaveLength(deniedCount);
 deny=false;fireEvent.click(screen.getByRole('button',{name:'Retry history'}));await act(async()=>{await Promise.resolve();await Promise.resolve();});
 expect(urls.at(-1)).toContain('afterSequence=0');await act(async()=>{await vi.advanceTimersByTimeAsync(10_000);});
 expect(urls.filter(u=>u.includes('mode=poll')).at(-1)).not.toContain('cursor=');
});
