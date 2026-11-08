import React from 'react';
import {afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {JobPrivateChat} from './job-private-chat';
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.useRealTimers();});
it('reloads private history from sequence zero after access restoration',async()=>{
 vi.useFakeTimers(); let denied=false;
 const answer={messageId:'saved-1',sequence:1,reply:{text:'Previously saved private answer',asOf:'2026-11-07T12:00:00Z',unknowns:[]}};
 const urls:string[]=[];
 vi.stubGlobal('fetch',vi.fn(async(url:string)=>{
  urls.push(url);
  if(denied)return {ok:false,status:401};
  if(url.includes('mode=poll'))return {ok:true,json:async()=>({cursor:'a'.repeat(64),changed:false})};
  return {ok:true,json:async()=>({exchanges:url.includes('afterSequence=0')?[answer]:[],nextAfterSequence:1,hasMore:false})};
 }));
 render(<JobPrivateChat jobId="owned-job"/>);
 await act(async()=>{await Promise.resolve();await Promise.resolve();});
 expect(screen.getByText('Previously saved private answer')).toBeTruthy();
 denied=true;
 await act(async()=>{await vi.advanceTimersByTimeAsync(10_000);});
 expect(screen.queryByText('Previously saved private answer')).toBeNull();
 denied=false;
 fireEvent.click(screen.getByRole('button',{name:'Retry history'}));
 await act(async()=>{await Promise.resolve();await Promise.resolve();});
 expect(urls.filter(u=>u.includes('afterSequence=0')).length).toBeGreaterThan(1);
 expect(screen.getByText('Previously saved private answer')).toBeTruthy();
});
it('does not restore a stale in-flight progress reply after access denial',async()=>{
 let resolvePoll!:(value:unknown)=>void;
 vi.stubGlobal('fetch',vi.fn((url:string)=>url.includes('mode=poll')?new Promise(resolve=>{resolvePoll=resolve;}):Promise.resolve({ok:false,status:401})));
 render(<JobPrivateChat jobId="owned-job"/>);
 await screen.findByText('Sign in again to read your private chat.');
 await act(async()=>{resolvePoll({ok:true,json:async()=>({cursor:'a'.repeat(64),changed:true,reply:{text:'Late private progress',asOf:'2026-11-07T12:00:00Z',unknowns:[]}})});await Promise.resolve();});
 expect(screen.queryByText('Late private progress')).toBeNull();
});
it('drops pre-revocation poll responses even after history access is restored',async()=>{
 let resolvePoll!:(value:unknown)=>void;let denied=true;
 vi.stubGlobal('fetch',vi.fn((url:string)=>{
  if(url.includes('mode=poll'))return new Promise(resolve=>{resolvePoll=resolve;});
  return Promise.resolve(denied?{ok:false,status:401}:{ok:true,json:async()=>({exchanges:[],nextAfterSequence:0,hasMore:false})});
 }));
 render(<JobPrivateChat jobId="owned-job"/>);
 await screen.findByText('Sign in again to read your private chat.');
 denied=false;fireEvent.click(screen.getByRole('button',{name:'Retry history'}));
 await screen.findByText(/No answers yet/);
 await act(async()=>{resolvePoll({ok:true,json:async()=>({cursor:'a'.repeat(64),changed:true,reply:{text:'Pre-revocation private progress',asOf:'2026-11-07T12:00:00Z',unknowns:[]}})});await Promise.resolve();});
 expect(screen.queryByText('Pre-revocation private progress')).toBeNull();
});
it('drops pre-revocation send responses after history access restoration',async()=>{
 vi.useFakeTimers();let denied=false;let resolvePost!:(v:unknown)=>void;let messageId='';
 vi.stubGlobal('fetch',vi.fn((url:string,init:RequestInit)=>{
  if(init.method==='POST'){messageId=JSON.parse(String(init.body)).messageId;return new Promise(resolve=>{resolvePost=resolve;});}
  if(denied)return Promise.resolve({ok:false,status:401});
  return Promise.resolve({ok:true,json:async()=>url.includes('mode=poll')?{cursor:'a'.repeat(64),changed:false}:{exchanges:[],nextAfterSequence:0,hasMore:false}});
 }));
 render(<JobPrivateChat jobId="owned-job"/>);await act(async()=>{await Promise.resolve();await Promise.resolve();});
 fireEvent.change(screen.getByLabelText('Ask about this evaluation'),{target:{value:'progress?'}});fireEvent.click(screen.getByRole('button',{name:'Send question'}));
 denied=true;await act(async()=>{await vi.advanceTimersByTimeAsync(10_000);});
 denied=false;fireEvent.click(screen.getByRole('button',{name:'Retry history'}));await act(async()=>{await Promise.resolve();await Promise.resolve();});
 await act(async()=>{resolvePost({ok:true,json:async()=>({exchange:{messageId,sequence:1,reply:{text:'Old-session saved answer',asOf:'2026-11-07T12:00:00Z',unknowns:[]}}})});await Promise.resolve();});
 expect(screen.queryByText('Old-session saved answer')).toBeNull();
});
