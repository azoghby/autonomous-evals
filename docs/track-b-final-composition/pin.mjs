// Explicit review operation; stage.mjs only verifies and never refreshes pins.
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const dirs=['docs/complete-workflow-integration','docs/workflow-data-bridge','docs/workflow-integration','docs/data-production-integration','docs/progress-chat-integration','docs/structured-progress-integration','docs/workflow-remediation-integration','docs/workflow-pack-integration','docs/chat-workflow-release','docs/release-packaging-integration','docs/controlled-acceptance-targets','docs/track-b-final-composition','tests/track-b/final-composition','tests/track-b/pack-integration','tests/track-b/chat-workflow-release/restored/chat-release/security','tests/track-b/chat-release/security','tests/track-b/chat-workflow-release/ui'];
const files=execFileSync('rg',['--files',...dirs],{cwd:root,encoding:'utf8'}).trim().split('\n').filter(p=>/\.(mjs|cjs|json|patch|ts|tsx|sql)$/.test(p)&&!/\/evidence[^/]*\//.test(p)&&!p.endsWith('/INTEGRITY.json')&&!p.endsWith('/RESULTS.json')&&!p.endsWith('/APPLICATION.json')&&!p.endsWith('/application.patch'));
files.push('packages/core/src/evals/integration/approved-suite.ts');
const pins={trackA:'530af32067279497161c22ab00006247851d9200',trackB:'687b5086e6bd204fe82809672c0511e2ee3e6f52',applicationBaseline:'f0068733ca49c37f40fd7de279325f21a4b5fbbb',historicalCore:'e61ad9719a1f7cfc844523cffbd72253dcdcb30b',acceptanceIntegration:'449c05df550afa0ac1f8b6030cc9fc8bbadbf52e'};
writeFileSync(join(root,'docs/track-b-final-composition/INTEGRITY.json'),JSON.stringify({format:1,pins,sha256:Object.fromEntries([...new Set(files)].sort().map(p=>[p,createHash('sha256').update(readFileSync(join(root,p))).digest('hex')]))},null,2)+'\n');
