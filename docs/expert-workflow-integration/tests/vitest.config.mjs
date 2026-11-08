import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const stage = process.env.EXPERT_WORKFLOW_STAGE ?? '/tmp/expert-workflow-mount-stage';
export default {
  resolve: { alias: {
    'workflow': `${stage}/node_modules/workflow/dist/index.js`,
    '@workflow-test': `${stage}/apps/web/src/workflows`,
    '@ae/core': `${stage}/packages/core/src`,
    '@': `${stage}/apps/web/src`,
    'server-only': `${stage}/test/stubs/server-only.ts`,
  } },
  test: { include: [`${here}/*.test.ts`], maxWorkers: 1, testTimeout: 20000 },
};
