import test from 'node:test';
import assert from 'node:assert/strict';
import {assertAcceptanceBudget} from '../../../docs/track-b-final-composition/calendar/apply.mjs';
test('default Text24 + Calendar8 plan exhausts approved target32 cap',()=>{assert.equal(assertAcceptanceBudget(),32);assert.equal(assertAcceptanceBudget({}),32);});
test('reproductions or pack requests reject before any dispatch when target32 cap exhausted',()=>{
 for(const plan of [{reproductions:1},{pack:1},{reproductions:1,pack:1}]){
  let dispatches=0;const run=()=>{assertAcceptanceBudget(plan);dispatches++;};assert.throws(run,/exceeds approved cap before dispatch/);assert.equal(dispatches,0);
 }
});
test('explicitly approved expanded cap or reviewed reduced plan admits exact total',()=>{assert.equal(assertAcceptanceBudget({reproductions:2,pack:3,cap:37}),37);assert.equal(assertAcceptanceBudget({text:12,calendar:8,reproductions:2,pack:10}),32);assert.equal(assertAcceptanceBudget({text:0,calendar:0,cap:0}),0);});
test('rejects invalid counts and cap without dispatch',()=>{
 for(const key of ['text','calendar','reproductions','pack','cap'])for(const value of [-1,0.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1,'1',null,{},false]){
  let dispatches=0;assert.throws(()=>{assertAcceptanceBudget({[key]:value});dispatches++;},/exceeds approved cap before dispatch/);assert.equal(dispatches,0);
 }
});
