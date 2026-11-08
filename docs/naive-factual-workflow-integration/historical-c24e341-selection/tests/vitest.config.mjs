import { fileURLToPath } from 'node:url';
const p = rel => fileURLToPath(new URL(rel,import.meta.url));
export default {
 resolve: { alias: [
  {find:/^server-only$/,replacement:p('../../../test/stubs/server-only.ts')},
  {find:/^@ae\/core\//,replacement:p('../../../packages/core/src/')},
  {find:/^@\//,replacement:p('../../../apps/web/src/')},
 ] },
 test: {include:[p('../postimages/apps/web/src/server/*.test.ts')],maxWorkers:1,testTimeout:60000,hookTimeout:60000},
};
