import {defineConfig} from 'vitest/config';
import {resolve} from 'node:path';
const stage=process.env.ROUTING_STAGE;
if(!stage)throw new Error('ROUTING_STAGE required: exact source snapshot with postimages overlaid');
export default defineConfig({resolve:{alias:[{find:/^server-only$/,replacement:resolve(stage,'test/stubs/server-only.ts')},{find:/^@\//,replacement:resolve(stage,'apps/web/src/')+'/'},{find:/^@ae\/core\//,replacement:resolve(stage,'packages/core/src/')+'/'}]},test:{include:['docs/naive-generic-routing-integration/*.test.ts'],testTimeout:10000}});
