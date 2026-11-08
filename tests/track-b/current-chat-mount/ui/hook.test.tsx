import React from 'react';
import {afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,render,screen} from '@testing-library/react';
import {useLiveJob} from './use-live-job';
import {connectLive} from './live-connection';
import {api} from './api';
vi.mock('./live-connection',()=>({connectLive:vi.fn(()=>()=>{})}));
vi.mock('./api',()=>({api:vi.fn(()=>new Promise(()=>{}))}));
afterEach(()=>{cleanup();vi.clearAllMocks();});
function View({id,enabled=true}:{id:string;enabled?:boolean}){const v=useLiveJob(id,enabled);return <div>{v.progress?.map(p=>p.message).join('|')}</div>;}
const rows=(text:string)=>({progress:[{milestone:'running',message:text,created_at:'2026-11-07T12:00:00Z'}]});
it('clears prior-job progress on a job switch before the next result arrives',()=>{
 const view=render(<View id="job-a"/>);const a=(connectLive as any).mock.calls[0][0];
 act(()=>a.onRows(rows('A private progress')));expect(screen.getByText('A private progress')).toBeTruthy();
 view.rerender(<View id="job-b"/>);expect(screen.queryByText('A private progress')).toBeNull();
});
it('ignores an old live subscription callback after another job activates',()=>{
 const view=render(<View id="job-a"/>);const a=(connectLive as any).mock.calls[0][0];
 view.rerender(<View id="job-b"/>);const b=(connectLive as any).mock.calls[1][0];
 act(()=>b.onRows(rows('B private progress')));act(()=>a.onRows(rows('A late private progress')));
 expect(screen.getByText('B private progress')).toBeTruthy();expect(screen.queryByText('A late private progress')).toBeNull();
});
it('clears private progress when its owner disables live reads',()=>{
 const view=render(<View id="job-a"/>);const a=(connectLive as any).mock.calls[0][0];
 act(()=>a.onRows(rows('A private progress')));view.rerender(<View id="job-a" enabled={false}/>);
 expect(screen.queryByText('A private progress')).toBeNull();
});

it('does not start old-job polling from a late previous subscription failure',()=>{
 const view=render(<View id="job-a"/>);const a=(connectLive as any).mock.calls[0][0];
 view.rerender(<View id="job-b"/>);act(()=>a.onFail());expect(api).not.toHaveBeenCalled();
});
