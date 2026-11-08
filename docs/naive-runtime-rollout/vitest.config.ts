import { defineConfig } from 'vitest/config';
export default defineConfig({ test: {
  environment: 'node', include: ['docs/naive-runtime-rollout/verify-schema.test.ts'],
  testTimeout: 60_000, hookTimeout: 60_000, fileParallelism: false,
} });
