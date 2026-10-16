#!/usr/bin/env node
// Execute the actual TypeScript class with fake native APIs; not a copied algorithm.
const { spawnSync } = require('node:child_process');
const { resolve } = require('node:path');
const result = spawnSync(process.execPath, ['--test',
  resolve(__dirname, '../../frontend/tests/voiceClientStt-lifecycle.test.cjs'),
  resolve(__dirname, '../../frontend/tests/review-blockers.test.cjs'),
], { stdio: 'inherit' });
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
