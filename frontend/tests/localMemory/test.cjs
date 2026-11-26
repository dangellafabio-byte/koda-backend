const assert = require('node:assert/strict');
const { MemoryStore } = require(process.argv[2]);

async function main() {
  const rows = new Map();
  const erased = new Set();
  const db = {
    execAsync: async () => {},
    getAllAsync: async (sql, account, key) => {
      if (sql.includes('local_memory_restore_block')) return erased.has(account) ? [{}] : [];
      return [...rows.values()].filter(row => row.account === account && (key === undefined || row.key === key));
    },
    runAsync: async (sql, account, key, value, revision, deleted) => {
      if (sql.startsWith('DELETE')) {
        for (const [id, row] of rows) if (row.account === account) rows.delete(id);
      } else if (sql.includes('local_memory_restore_block')) {
        erased.add(account);
      } else {
        rows.set(JSON.stringify([account, key]), {account, key, value, revision, deleted});
      }
    },
    withExclusiveTransactionAsync: async task => task(db),
  };
  const a = new MemoryStore(db, 'a');
  const b = new MemoryStore(db, 'b');
  await a.init();
  const set = {key: 'friend.teo', value: 'amico', expectedRevision: 0, kind: 'set', confirmed: true};
  await a.change(set);
  assert.equal((await a.list())[0].value, 'amico');
  assert.equal((await b.list()).length, 0);
  await assert.rejects(a.change(set), /Stale change/);
  await a.change({...set, kind: 'forget', expectedRevision: 1});
  assert.equal((await a.list())[0].value, '');
  assert.equal((await a.list())[0].deleted, true);
  await b.change(set);
  await a.eraseAccount();
  assert.equal((await a.list()).length, 0);
  assert.equal((await b.list()).length, 1);
  console.log('7 assertions passed (mock adapter)');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
