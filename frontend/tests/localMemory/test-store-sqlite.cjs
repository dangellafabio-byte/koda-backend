const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createCipheriv, createDecipheriv, randomBytes } = require('node:crypto');
const { MemoryStore } = require(process.argv[2]);
const { serializedDatabase } = require(process.argv[3]);
const { createBackup } = require(process.argv[4]);

const set = (key, value, expectedRevision = 0) => ({ key, value, expectedRevision, kind: 'set', confirmed: true });
const approved = (key, value) => ({ key, value, approved: true });

function backupCrypto() {
  const key = randomBytes(32);
  return {
    async seal(text, aad) {
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(Buffer.from(aad));
      const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), body]).toString('base64');
    },
    async open(blob, aad) {
      const raw = Buffer.from(blob, 'base64');
      const cipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
      cipher.setAAD(Buffer.from(aad));
      cipher.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([cipher.update(raw.subarray(28)), cipher.final()]).toString('utf8');
    },
  };
}

async function main() {
  const sqlite = new DatabaseSync(':memory:');
  const db = serializedDatabase({
    execAsync: async sql => sqlite.exec(sql),
    getAllAsync: async (sql, ...args) => sqlite.prepare(sql).all(...args),
    runAsync: async (sql, ...args) => sqlite.prepare(sql).run(...args),
    closeAsync: async () => sqlite.close(),
  });
  const a = new MemoryStore(db, 'a');
  const b = new MemoryStore(db, 'b');
  await a.init();
  await a.init();
  await a.change(set('friend.teo', 'Un ufficiale'));
  await assert.rejects(a.applyApprovedChanges([
    set('friend.teo', 'Un amico', 1),
    set('friend.teo', 'Una proposta obsoleta', 1),
  ]), /Stale change/);
  assert.equal((await a.list())[0].value, 'Un ufficiale');
  await a.change(set('friend.teo', 'Un amico', 1));
  await a.change({ ...set('friend.teo', '', 2), kind: 'forget' });
  assert.deepEqual(await a.list(), [{ key: 'friend.teo', value: '', deleted: true, revision: 3 }]);

  assert.equal(await a.importApproved([
    approved('friend.teo', 'Il valore cancellato'),
    approved('pet.name', 'Nina'),
    approved('pet.name', 'Nina'),
    approved('city.home', 'Bari'),
    approved('city.home', 'Torino'),
    { ...approved('not.reviewed', 'Valore'), approved: false },
  ]), 1);
  assert.equal(await a.importApproved([approved('pet.name', 'Nina')]), 0);
  assert.equal((await a.list()).length, 2);
  assert.deepEqual(await b.list(), []);

  const crypto = backupCrypto();
  const facts = await a.list();
  const backup = await createBackup('a', facts, crypto);
  await assert.rejects(a.restoreFreshBackup(backup, crypto), /Existing memory/);
  await assert.rejects(b.restoreFreshBackup(backup, crypto));
  await b.restoreFreshBackup(await createBackup('b', facts, crypto), crypto);
  assert.deepEqual(await b.list(), facts);
  await a.eraseAccount();
  await assert.rejects(a.restoreFreshBackup(backup, crypto), /Account memory erased/);
  await assert.rejects(a.importApproved([approved('pet.name', 'Nina')]), /Account memory erased/);
  await assert.rejects(a.change(set('friend.teo', 'Proposta tardiva')), /Account memory erased/);
  assert.deepEqual(await a.list(), []);
  assert.deepEqual(await b.list(), facts);

  const admitted = b.list();
  const close = db.close();
  assert.equal(db.close(), close);
  await assert.rejects(b.list(), /closed/);
  assert.deepEqual(await admitted, facts);
  await close;
  console.log('SQLite locale: transazioni, isolamento, migrazione, backup AES-GCM e chiusura verificati; SQLCipher non usato.');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
