const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { stripTypeScriptTypes } = require('./load-ts.cjs');
const vm = require('node:vm');
const path = require('node:path');
function load(file, globals, exports) {
  let s = readFileSync(path.join(__dirname, '../lib/', file), 'utf8');
  s = s.replace(/^import[\s\S]*?from ["'][^"']+["'];?/gm, '');
  s = stripTypeScriptTypes(s).replace(/^export /gm, '');
  const ctx = { console, setTimeout: () => 1, clearTimeout() {}, ...globals };
  vm.runInNewContext(s + `\nglobalThis.result = {${exports.join(',')}};`, ctx);
  return ctx.result;
}

test('bundled intro uses the selected provider on each play, including switching back', async () => {
  let provider = 'elevenlabs';
  const assets = load('introAssetProvider.ts', {
    readTTSProviderSync: () => provider, require: filename => filename,
  }, ['getIntroAsset']);
  const played = [];
  const la = load('lasciaAndareVoice.ts', {
    getIntroAsset: assets.getIntroAsset,
    createAudioPlayer(source) {
      played.push(source);
      return { addListener(_event, fn) { queueMicrotask(() => fn({ didJustFinish: true })); }, play() {}, pause() {}, remove() {} };
    },
  }, ['playOpenPhrase', 'playClosePhrase', 'playFirstBootIntroSequence']);
  await la.playOpenPhrase('cielo');
  provider = 'inworld';
  await la.playOpenPhrase('cielo');
  await la.playFirstBootIntroSequence();
  provider = 'elevenlabs';
  await la.playOpenPhrase('cielo');
  assert.ok(!played[0].includes('-inworld/'));
  assert.ok(played[1].includes('lascia-andare-inworld/'));
  assert.ok(played[2].includes('intro-inworld/'));
  assert.ok(played[3].includes('intro-inworld/'));
  assert.equal(played[4], played[0]);
});

function providerClient(fetch) {
  const stored = new Map();
  const api = load('ttsProviderClient.ts', {
    SecureStore: {
      getItemAsync: async key => stored.get(key) || null,
      setItemAsync: async (key, value) => stored.set(key, value),
      deleteItemAsync: async key => stored.delete(key),
    },
    fetch, useEffect() {}, useState() {},
  }, ['setTTSProvider', 'readTTSProviderSync', 'resetProviderOnServer']);
  return api;
}

test('a rejected server reset preserves the Inworld setting instead of reporting a false switch', async () => {
  const api = providerClient(async () => ({ ok: false, status: 503 }));
  await api.setTTSProvider('inworld', 'review');
  await assert.rejects(api.resetProviderOnServer('https://example.test', {}), /HTTP 503/);
  assert.equal(api.readTTSProviderSync(), 'inworld');
});

test('a confirmed server reset updates the local setting to ElevenLabs', async () => {
  const api = providerClient(async () => ({ ok: true, json: async () => ({ provider: 'elevenlabs' }) }));
  await api.setTTSProvider('inworld', 'review');
  await api.resetProviderOnServer('https://example.test', {});
  assert.equal(api.readTTSProviderSync(), 'elevenlabs');
});

test('a missing reset endpoint is not proof that the stored preference was deleted', async () => {
  const api = providerClient(async () => ({ ok: false, status: 404 }));
  await api.setTTSProvider('inworld', 'review');
  await assert.rejects(api.resetProviderOnServer('https://example.test', {}));
  assert.equal(api.readTTSProviderSync(), 'inworld');
});

test('Inworld cannot silently play ElevenLabs Vento assets', () => {
  const assets = load('introAssetProvider.ts', {
    readTTSProviderSync: () => 'inworld', require: filename => filename,
    console: { error() {} },
  }, ['getIntroAsset']);
  assert.throws(() => assets.getIntroAsset('la_open_vento'), /Inworld/);
  assert.throws(() => assets.getIntroAsset('la_close_vento'), /Inworld/);
});
