#!/usr/bin/env node
// Offline only: no server, installs, remote calls or provider use.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const testFile = fileURLToPath(new URL('./route.test.mjs', import.meta.url));
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', testFile], { stdio: 'inherit', env: process.env });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
console.log('OFFLINE CONTROLLED INTERNAL FIXTURES ONLY. Direct route functions and actual PGlite simulator SQL; no hosted HTTP, Gateway, remote prompt attestation or production acceptance.');
