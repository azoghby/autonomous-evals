import { describe, it, expect } from 'vitest';
import { freezeSandboxInputs, verifySandboxInputs } from './identity';
const fixture = () => ({
 environment: { specVersion:'sandbox-spec-v1',id:'fixture',name:'Fixture',domain:'calendar',
  tools:[{name:'book',description:'Book',inputSchema:{type:'object'},effect:'write',source:'fixture',binding:{kind:'sql',statements:['SELECT 1']}}],
  state:{ddl:'CREATE TABLE events(id text)',seedSql:''},
  workflows:[{id:'booking',name:'Booking',description:'Book an event',tools:['book']}],
  policies:[{id:'policy',title:'Policy',clauses:[{id:'one',text:'Do not double book.'}]}],integration:{mode:'tool_loop',endpointUrl:'https://example.com/chat',model:'fixture'} },
 scenarios:[{id:'sx_booking',workflowId:'booking',title:'Booking',category:'happy_path',persona:{name:'User',goal:'Book',knowledge:[],style:'brief'},
 stateAssertions:[{id:'booked',description:'Booked',sql:'SELECT true AS ok',severity:'high'}]}],
});
describe('sandbox shared input identity',()=>{
 it('binds suite to environment and immutable nested snapshots',()=>{
  const f=fixture(),a=freezeSandboxInputs(f.environment,f.scenarios);
  f.environment.tools[0]!.binding.statements[0]='DELETE FROM events';
  f.scenarios[0]!.persona.goal='Different';
  expect(a.environment.tools[0]!.binding).toMatchObject({statements:['SELECT 1']});
  expect(a.scenarios[0]!.persona.goal).toBe('Book');
  expect(()=>{a.scenarios[0]!.persona.goal='Change';}).toThrow();
  expect(verifySandboxInputs(JSON.parse(JSON.stringify(a)))).toEqual(a);
  const b=freezeSandboxInputs(f.environment,f.scenarios);expect(b.envHash).not.toBe(a.envHash);expect(b.suiteHash).not.toBe(a.suiteHash);
 });
 it('canonicalizes object key order and schema defaults',()=>{
  const f=fixture();const a=freezeSandboxInputs(f.environment,f.scenarios);
  const b=freezeSandboxInputs({...f.environment,tools:f.environment.tools.map(t=>({...t,inputSchema:{type:'object'}}))},f.scenarios);
  expect(a.suiteHash).toBe(b.suiteHash);
  expect(freezeSandboxInputs(a.environment,a.scenarios)).toEqual(a);
 });
 it.each(['envHash','suiteHash','specVersion','identityVersion'])('rejects a changed persisted %s',key=>{
  const f=fixture();expect(()=>verifySandboxInputs({...freezeSandboxInputs(f.environment,f.scenarios),[key]:'changed'})).toThrow('sandbox_input_identity_invalid');
 });
 it('rejects persisted contents modified without changing their hashes',()=>{
  const f=fixture();const a=structuredClone(freezeSandboxInputs(f.environment,f.scenarios));a.scenarios[0]!.persona.goal='Different';expect(()=>verifySandboxInputs(a)).toThrow();
 });
 it('rejects duplicate tools, scenarios and check identities',()=>{
  const f=fixture();expect(()=>freezeSandboxInputs({...f.environment,tools:[...f.environment.tools,...f.environment.tools]},f.scenarios)).toThrow();
  expect(()=>freezeSandboxInputs(f.environment,[...f.scenarios,...f.scenarios])).toThrow();
  expect(()=>freezeSandboxInputs(f.environment,[{...f.scenarios[0],requiredOutputs:[{id:'booked',description:'Duplicate',mustMention:['done']}]}])).toThrow();
 });
 it('rejects absent workflows and tool references',()=>{
  const f=fixture();expect(()=>freezeSandboxInputs(f.environment,[{...f.scenarios[0],workflowId:'missing'}])).toThrow();
  expect(()=>freezeSandboxInputs(f.environment,[{...f.scenarios[0],faults:[{tool:'missing',fault:'timeout'}]}])).toThrow();
  expect(()=>freezeSandboxInputs(f.environment,[{...f.scenarios[0],trajectoryAssertions:[{id:'order',type:'before',first:'missing',then:'book',description:'order',severity:'high'}]}])).toThrow();
 });
 it('rejects SQL result index outside the declared statement list',()=>{
  const f=fixture();expect(()=>freezeSandboxInputs({...f.environment,tools:[{...f.environment.tools[0],binding:{kind:'sql',statements:['SELECT 1'],resultFrom:1}}]},f.scenarios)).toThrow();
 });
 it('does not promote a schema-valid scenario into oracle validation',()=>{
  const f=fixture();expect(freezeSandboxInputs(f.environment,f.scenarios).scenarios[0]!.oracleValidated).toBe(false);
 });
 it('rejects empty suites, invalid UTF-8 text and non-JSON schema values safely',()=>{
  const f=fixture();expect(()=>freezeSandboxInputs(f.environment,[])).toThrow();
  expect(()=>freezeSandboxInputs({...f.environment,name:'bad\u0000'},f.scenarios)).toThrow('sandbox_input_identity_invalid');
  expect(()=>freezeSandboxInputs({...f.environment,name:'bad\ud800'},f.scenarios)).toThrow('sandbox_input_identity_invalid');
  expect(()=>freezeSandboxInputs({...f.environment,tools:[{...f.environment.tools[0],inputSchema:{maximum:Infinity}}]},f.scenarios)).toThrow();
 });
});
