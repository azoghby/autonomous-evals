// Reuse historical build checks without writing its artifacts or changing its source.
import {readFileSync} from 'node:fs';
const original=new URL('../release-extensions/comparison/build.mjs',import.meta.url);
let code=readFileSync(original,'utf8').replace(/from '([^']+)'/g,(all,p)=>p.startsWith('.')?`from '${new URL(p,original).href}'`:all);
code=code.replace('const env={PATH:',"const env={npm_config_offline:'true',PNPM_CONFIG_OFFLINE:'true',PATH:");
await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
