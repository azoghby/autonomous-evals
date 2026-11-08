import {defineConfig} from 'vitest/config';
import root from '../../vitest.config';
export default defineConfig({...root,test:{...root.test,include:['docs/naive-judge-owner-recovery-integration/**/*.test.ts'],testTimeout:60000,hookTimeout:60000}});
