import path from 'node:path';
import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
const stage=process.env.EXPERT_REVIEW_STAGE??'/tmp/expert-review-api-stage';
export default {
 oxc:{jsx:{runtime:'automatic'}},
 resolve:{alias:{'@neondatabase/serverless':`${stage}/node_modules/@neondatabase/serverless/index.mjs`,'next':`${stage}/node_modules/next`,'react-dom':`${stage}/node_modules/react-dom`,'react':`${stage}/node_modules/react`,'@electric-sql/pglite':`${stage}/node_modules/@electric-sql/pglite`,'@review-routes':`${stage}/apps/web/src/app/api/operator/expert-reviews`,'@ae/core':`${stage}/packages/core/src`,'@':`${stage}/apps/web/src`,'server-only':`${stage}/test/stubs/server-only.ts`}},
 test:{include:[`${here}/*.test.ts`],maxWorkers:1,testTimeout:60000},
};
