import {describe,it,expect} from 'vitest';
import {objectivePassed,summarizeRunResults,type RunScenarioResult} from '../../../packages/core/src/contracts/services';
const check=(kind:'objective'|'rubric',status:'pass'|'fail'|'concern'|'inconclusive')=>({checkId:'check',kind,status,detail:'Evidence',evidenceQuotes:[],reason:null});
describe('binary consumers retain rich assessment distinctions',()=>{
 it('counts objective failure, rubric concern and unknown separately',()=>{
 const results:RunScenarioResult[]=[{scenarioId:'a',detail:'objective',passed:false,assessment:{kind:'objective',outcome:'completed',checks:[check('objective','fail')]}},{scenarioId:'b',detail:'rubric',assessment:{kind:'rubric',outcome:'completed',checks:[check('rubric','concern')]}},{scenarioId:'c',detail:'unknown',assessment:{kind:'inconclusive',outcome:'completed',checks:[check('rubric','inconclusive')]}}];
 expect(results.map(objectivePassed)).toEqual([false,undefined,undefined]);expect(summarizeRunResults(results)).toEqual({passed:0,failed:1,rubric:1,inconclusive:1,infrastructure:0});
 });
 it('preserves old boolean results',()=>expect(summarizeRunResults([{scenarioId:'a',detail:'',passed:true},{scenarioId:'b',detail:'',passed:false}])).toEqual({passed:1,failed:1,rubric:0,inconclusive:0,infrastructure:0}));
 it('does not promote incomplete objective evidence to a boolean',()=>{
 expect(objectivePassed({passed:false,assessment:{kind:'objective',outcome:'completed',checks:[]}})).toBeUndefined();
 expect(objectivePassed({passed:true,assessment:{kind:'objective',outcome:'infrastructure_error',checks:[check('objective','pass')]}})).toBeUndefined();
 expect(objectivePassed({passed:true,assessment:{kind:'objective',outcome:'completed',checks:[check('rubric','pass')]}})).toBeUndefined();
 });
});
