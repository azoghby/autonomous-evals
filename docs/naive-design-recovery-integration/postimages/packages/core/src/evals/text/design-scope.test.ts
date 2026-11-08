import { describe,it,expect } from 'vitest';
import { createHash } from 'node:crypto';
import { textDesignTaskScope,type TextDesignInput } from './design';
import { canonicalJson } from './freeze';
import { normalizeReferenceText } from './schema';
import { ADMISSION_VERSION } from './admission';
import { RUBRIC_ADMISSION_VERSION } from './rubric-admission';
const input:TextDesignInput={job:{jobId:'j',customerId:'c',environment:'test',package:'text_eval',isFixture:false,quoteVersion:null,linkedRetestOf:null},versionLabel:'v',systemPrompt:'Be useful.',referenceText:'  reference\r\ntext  '};
describe('canonical design scope',()=>{
 it('preserves historical exact identity and excludes secrets',()=>{
 const safe={...input,referenceText:normalizeReferenceText(input.referenceText)};
 const expected=createHash('sha256').update(canonicalJson({...safe,admissionVersion:ADMISSION_VERSION,rubricAdmissionVersion:RUBRIC_ADMISSION_VERSION})).digest('hex').slice(0,24);
 expect(textDesignTaskScope(input)).toBe(expected);
 expect(textDesignTaskScope({...input,knownSecrets:['hidden']})).toBe(expected);
 });
 it('binds canonical job, version, prompt, reference and policy',()=>{
 const scope=textDesignTaskScope(input);
 for(const modified of [{...input,job:{...input.job,linkedRetestOf:'other'}},{...input,versionLabel:'v2'},{...input,systemPrompt:'other'},{...input,referenceText:'other'},{...input,factualGapPolicy:'propose_missing_reference.v1' as const}])expect(textDesignTaskScope(modified)).not.toBe(scope);
 });
});
