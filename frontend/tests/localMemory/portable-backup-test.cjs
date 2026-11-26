const assert = require('node:assert/strict');
const {randomBytes} = require('node:crypto');
const {portableCrypto} = require(process.argv[2]);
async function test() {
  const key = randomBytes(32).toString('base64');
  const crypto = portableCrypto(key, async n => randomBytes(n));
  const archive = await crypto.seal('ricordo privato', 'account-a');
  assert.ok(!archive.includes('ricordo privato') && !archive.includes('account-a'));
  assert.notEqual(await crypto.seal('ricordo privato', 'account-a'), archive);
  assert.equal(await crypto.open(archive, 'account-a'), 'ricordo privato');
  await assert.rejects(crypto.open(archive, 'account-b'));
  await assert.rejects(portableCrypto(randomBytes(32).toString('base64'), async n => randomBytes(n)).open(archive, 'account-a'));
  const [prefix, nonce, data] = archive.split('.');
  await assert.rejects(crypto.open([prefix, nonce, (data[0] === 'A' ? 'B' : 'A') + data.slice(1)].join('.'), 'account-a'));
  console.log('Backup portatile: cifratura autenticata, nonce, integrità, chiave e account verificati.');
}
test().catch(error => {console.error(error); process.exitCode=1;});
