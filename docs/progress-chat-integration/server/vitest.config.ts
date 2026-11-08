import { defineConfig } from 'vitest/config';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const stage = process.env.CHAT_STAGE_DIR;
if (!stage) throw new Error('CHAT_STAGE_DIR must name the patched exact-base disposable staging');
const here = path.dirname(fileURLToPath(import.meta.url));
export default defineConfig({ resolve: { alias: [
  { find: '@chat-server', replacement: path.join(stage, 'apps/web/src/server/progress-chat.ts') },
  { find: '@chat-route', replacement: path.join(stage, 'apps/web/src/app/api/jobs/[jobId]/chat/route.ts') },
  { find: '@/server/progress-chat', replacement: path.join(stage, 'apps/web/src/server/progress-chat.ts') },
  { find: './session', replacement: path.join(here, 'fixture-session.ts') },
  { find: '@ae/core/reporting/chat/index', replacement: path.join(stage, 'packages/core/src/reporting/chat/index.ts') },
  { find: '@ae/core/storage/crypto', replacement: path.join(stage, 'packages/core/src/storage/crypto.ts') },
  { find: '@ae/core/agents/redact', replacement: path.join(stage, 'packages/core/src/agents/redact.ts') },
  { find: '@neondatabase/serverless', replacement: path.join(here, 'fixture-pool.ts') },
  { find: 'server-only', replacement: path.join(here, 'empty.ts') },
] }, test: { include: [path.join(here, '*.test.ts')], maxWorkers: 1, minWorkers: 1 } });
