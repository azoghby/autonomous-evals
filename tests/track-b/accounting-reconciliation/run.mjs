/** Offline runner: uses installed dependencies; never installs or reads environment secrets. */
import {mkdtempSync,cpSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
const root=resolve(import.meta.dirname,'../../..');
const deps=process.env.ACCOUNTING_NODE_MODULES;
if(!deps)throw Error('Set ACCOUNTING_NODE_MODULES to an existing installed node_modules directory');
const stage=mkdtempSync(join(tmpdir(),'accounting-reconciliation-'));
for(const name of ['packages','tests/track-b/accounting-reconciliation'])cpSync(join(root,name),join(stage,name),{recursive:true});
symlinkSync(resolve(deps),join(stage,'node_modules'));
console.log('Offline staged SQL test root:',stage);
execFileSync(process.execPath,[join(deps,'vitest/vitest.mjs'),'run','--root',stage,'--config',join(stage,'tests/track-b/accounting-reconciliation/vitest.config.mjs')],{stdio:'inherit',env:{...process.env,npm_config_offline:'true'}});
