#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const { resolve } = require('node:path');
const result = spawnSync(process.execPath, ['--test', '--test-name-pattern=warmup',
  resolve(__dirname, '../../frontend/tests/voiceClientStt-lifecycle.test.cjs'),
], { stdio: 'inherit' });
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
