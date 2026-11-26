#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
work=$(mktemp -d "$PWD/.portable.XXXXXXXX")
trap 'rm -rf "$work"' EXIT
node_modules/.bin/tsc --strict --skipLibCheck --target es2022 --module commonjs --outDir "$work" lib/localMemoryPortable.ts
node tests/localMemory/portable-backup-test.cjs "$work/localMemoryPortable.js"
