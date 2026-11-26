#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
compiler=${TSC:-"$PWD/node_modules/.bin/tsc"}
work=$(mktemp -d "$PWD/.ollenya-test.XXXXXXXX")
trap 'rm -rf "$work"' EXIT
"$compiler" --strict --target es2022 --module commonjs --outDir "$work/build" lib/localMemory/*.ts
cp tests/localMemory/*.cjs "$work"
export NODE_PATH="$PWD/node_modules${NODE_PATH:+:$NODE_PATH}"
cd "$work"
for file in test*.cjs; do
  printf '\n%s\n' "$file"
  case "$file" in
    test-apple*.cjs) modules=(memoryApple);;
    test-cipher.cjs) modules=(memoryEncryptedDb);;
    test-dispatch.cjs) modules=(memoryDispatch);;
    test-engine.cjs) modules=(memoryEngine);;
    test-expo-platform.cjs) modules=(memoryExpoPlatform);;
    test-lifecycle.cjs) modules=(memoryLifecycle);;
    test-migration.cjs) modules=(memoryMigration);;
    test-store-sqlite.cjs) modules=(memoryStore memoryEncryptedDb memoryBackup);;
    test.cjs) modules=(memoryStore);;
    *) modules=();;
  esac
  args=()
  for module in "${modules[@]}"; do args+=("./build/$module.js"); done
  node "$file" "${args[@]}"
done
if [[ "${1:-}" == "--benchmark" ]]; then
  cp "$OLDPWD/tests/localMemory/benchmark-retrieval.cjs" .
  node benchmark-retrieval.cjs
fi
