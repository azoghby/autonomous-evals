import {cpSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';

/** Run the unchanged historical assertions against the fully composed application. */
export function prepareComparison(stage,root) {
  const target=join(stage,'comparison-tests');
  cpSync(join(root,'tests/track-b/workflow-comparison-integration'),target,{recursive:true});
  const fixture=join(target,'app.test.ts');
  const source=readFileSync(fixture,'utf8');
  if(source.split('004-rich-comparison.sql').length!==2)throw Error('Comparison fixture migration reference changed; review before adapting');
  writeFileSync(fixture,source.replace('004-rich-comparison.sql','006-rich-comparison.sql'));
  const marker="describe('actual app + engine + durable SQL checkpoints (offline fixtures)'";
  if(!source.includes(marker))throw Error('Historical comparison fixture boundary changed');
  writeFileSync(join(target,'monitoring-reuse.test.ts'),source.slice(0,source.indexOf(marker)).replace('004-rich-comparison.sql','006-rich-comparison.sql').replace("kind='app_rich_tick'","kind='app_rich_tick' AND state='pending'")+readFileSync(join(root,'tests/track-b/release-extensions/comparison/monitoring-reuse.fixture.ts'),'utf8'));
  writeFileSync(join(target,'empty.ts'),'export {};\n');
  const aliases=[{find:'server-only',replacement:join(target,'empty.ts')},{find:'@/',replacement:join(stage,'apps/web/src/')}];
  const config='vitest.extension-comparison.config.mjs';
  writeFileSync(join(stage,config),`export default {resolve:{alias:[...${JSON.stringify(aliases)},{find:/^@ae\\/core\\/(.*)$/,replacement:${JSON.stringify(join(stage,'packages/core/src/$1'))}}]},test:{include:['comparison-tests/**/*.test.ts'],maxWorkers:1,fileParallelism:false,testTimeout:30000}};\n`);
  return config;
}
