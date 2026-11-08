import React from 'react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {cleanup,render,screen} from '@testing-library/react';
import {JobView} from './job-view';
import {fixture} from './mount-fixture';
const persisted=[{milestone:'planning',message:'Persisted legacy event',createdAt:'2026-11-07T12:00:00Z'}];
const detail=(id='owned-job',state='running')=>({job:{id,state,package:'trace_audit',createdAt:'2026-11-07T12:00:00Z',environment:'test'},quotes:[],messages:[],progress:persisted,findings:[],payments:[],remediations:[]});
beforeEach(()=>{
 fixture.data=detail();fixture.loading=false;fixture.error=null;fixture.feed={mode:'polling'};fixture.redirects.length=0;
 vi.stubGlobal('fetch',vi.fn(async(url:string)=>({ok:true,json:async()=>url.includes('mode=poll')?{cursor:'a'.repeat(64),changed:true,reply:{text:'Persisted rich progress',asOf:'2026-11-07T12:00:00Z',unknowns:['Completion time remains unknown.']}}:{exchanges:[],nextAfterSequence:0,hasMore:false}})));
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it.each(['running','delivered','paused_budget','failed','cancelled'])('mounts actual private chat for matching authenticated detail in %s state',async(state)=>{
 fixture.data=detail('owned-job',state);render(<JobView jobId="owned-job"/>);
 expect(screen.getByRole('heading',{name:'Private progress chat'})).toBeTruthy();
 await screen.findByText('Persisted rich progress');
 expect((fetch as ReturnType<typeof vi.fn>).mock.calls.every(([url])=>url.startsWith('/api/jobs/owned-job/chat'))).toBe(true);
});
it.each(['loading','unauthenticated','forbidden','missing','mismatch'])('does not mount private chat for %s detail',async(kind)=>{
 if(kind==='loading')fixture.loading=true;
 if(kind==='unauthenticated')fixture.error={status:401};
 if(kind==='forbidden')fixture.error={status:403};
 if(kind==='missing')fixture.error={status:404};
 if(kind==='mismatch')fixture.data=detail('different-job');
 render(<JobView jobId="owned-job"/>);
 expect(screen.queryByRole('heading',{name:'Private progress chat'})).toBeNull();expect(fetch).not.toHaveBeenCalled();
 if(kind==='unauthenticated')expect(fixture.redirects).toContain('/signin?next=/jobs/owned-job');
});
it('keeps legacy timeline/feed while private rich progress loads independently',async()=>{
 render(<JobView jobId="owned-job"/>);
 const legacy=screen.getByTestId('timeline');expect(legacy.textContent).toContain('Persisted legacy event');
 expect(screen.getByTestId('agent-feed').textContent).toContain('Persisted legacy event');
 await screen.findByText('Persisted rich progress');
 expect(legacy.textContent).not.toContain('Persisted rich progress');
});
it('retains the current live legacy progress selection alongside private chat',async()=>{
 fixture.feed={mode:'live',state:'running',progress:[...persisted,{milestone:'running',message:'New persisted live event',createdAt:'2026-11-07T12:01:00Z'}]};
 render(<JobView jobId="owned-job"/>);await screen.findByText('Persisted rich progress');
 expect(screen.getByTestId('timeline').textContent).toContain('New persisted live event');
});
