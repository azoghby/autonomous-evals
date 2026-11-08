import {execFileSync} from 'node:child_process';
import {writeFileSync,symlinkSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {stageRelease} from './stage.mjs';
const {stage}=stageRelease();
const deps=resolve(process.env.CHAT_UI_NODE_MODULES??'/tmp/workflow-bootstrap.JpxCTM/node_modules');
symlinkSync(deps,join(stage,'node_modules'));
writeFileSync(join(stage,'vitest.transport.config.mjs'),`export default {test:{include:['packages/core/src/targets/transport.test.ts'],maxWorkers:1}};`);
execFileSync(process.execPath,[join(deps,'vitest/vitest.mjs'),'run','--config','vitest.transport.config.mjs'],{cwd:stage,stdio:'inherit'});
