import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const stage = process.env.EXPERT_REVIEW_STAGE ?? '/tmp/expert-review-api-stage';
export default {
  resolve: { alias: {
    '@electric-sql/pglite': `${stage}/node_modules/@electric-sql/pglite/dist/index.js`,
    '@review-routes': `${stage}/apps/web/src/app/api/operator/expert-reviews`,
    '@ae/core': `${stage}/packages/core/src`,
    '@': `${stage}/apps/web/src`,
    'server-only': `${stage}/test/stubs/server-only.ts`,
  } },
  test: { include: [`${here}/api-server.test.ts`], maxWorkers: 1, testTimeout: 20000 },
};
