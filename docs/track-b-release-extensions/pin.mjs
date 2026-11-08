// Explicit review operation only; never called by staging.
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {root,pins} from '../track-b-final-composition/stage.mjs';
import {join} from 'node:path';
const paths=['docs/track-b-final-composition/INTEGRITY.json','docs/track-b-final-composition/stage.mjs','docs/track-b-release-extensions/stage.mjs','docs/track-b-release-extensions/source/rich-evaluation.ts','docs/workflow-comparison-integration/app/004-rich-comparison.patch','docs/workflow-resumption-integration/resumption.patch','docs/complete-workflow-integration/source/apps/web/src/workflows/steps/rich-evaluation.ts','docs/workflow-resumption-integration/source/apps/web/src/workflows/steps/rich-evaluation.ts'];
writeFileSync(join(root,'docs/track-b-release-extensions/INTEGRITY.json'),JSON.stringify({format:1,parent:'40014f4cf0c08bc8c6986b4a40aa28a53695172c',pins,sha256:Object.fromEntries(paths.map(p=>[p,createHash('sha256').update(readFileSync(join(root,p))).digest('hex')]))},null,2)+'\n');
