import {applyChange, Fact, Change} from './memoryCore';
import {planFreshRestore, readBackup, BackupCrypto} from './memoryBackup';
import {planImport, ImportCandidate} from './memoryMigration';

/** Adapter must use an encrypted, account-scoped database. */
export interface MemoryDatabase {
  execAsync(sql: string): Promise<void>;
  getAllAsync<T>(sql: string, ...args: (string|number)[]): Promise<T[]>;
  runAsync(sql: string, ...args: (string|number)[]): Promise<unknown>;
  withExclusiveTransactionAsync(task: (tx: MemoryDatabase)=>Promise<void>): Promise<void>;
}

type Row = {key: string; value: string; revision: number; deleted: number};

export class MemoryStore {
  constructor(private db: MemoryDatabase, private account: string) {
    if (!account.trim()) throw Error('Account required');
  }

  async init() {
    await this.db.execAsync('CREATE TABLE IF NOT EXISTS local_facts (account TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, revision INTEGER NOT NULL, deleted INTEGER NOT NULL, PRIMARY KEY(account,key))');
    await this.db.execAsync('CREATE TABLE IF NOT EXISTS local_memory_restore_block (account TEXT PRIMARY KEY NOT NULL)');
  }

  list(): Promise<Fact[]> {
    return this.readFacts(this.db);
  }

  async change(change: Change): Promise<void> {
    await this.applyApprovedChanges([change]);
  }

  /** A stale revision or any invalid change rolls back the entire batch. */
  async applyApprovedChanges(changes: readonly Change[]): Promise<void> {
    const snapshot = changes.map(change => ({...change}));
    await this.db.withExclusiveTransactionAsync(async tx => {
      await this.requireActiveAccount(tx);
      for (const change of snapshot) {
        const facts = await this.readFacts(tx, change.key);
        const [next] = applyChange(facts, change);
        await this.writeFact(tx, next);
      }
    });
  }

  async importApproved(candidates: readonly ImportCandidate[]): Promise<number> {
    const snapshot = candidates.map(candidate => ({...candidate}));
    let imported = 0;
    await this.db.withExclusiveTransactionAsync(async tx => {
      await this.requireActiveAccount(tx);
      const planned = planImport(await this.readFacts(tx), snapshot);
      for (const change of planned) {
        const [fact] = applyChange([], change);
        await this.writeFact(tx, fact);
      }
      imported = planned.length;
    });
    return imported;
  }

  async restoreFreshBackup(ciphertext: string, crypto: BackupCrypto): Promise<void> {
    const backup = await readBackup(this.account, ciphertext, crypto);
    await this.db.withExclusiveTransactionAsync(async tx => {
      await this.requireActiveAccount(tx);
      const facts = planFreshRestore(await this.readFacts(tx), backup);
      for (const fact of facts) await this.writeFact(tx, fact);
    });
  }

  /** The local marker blocks replay of old snapshots after an account erase. */
  async eraseAccount(): Promise<void> {
    await this.db.withExclusiveTransactionAsync(async tx => {
      await tx.runAsync('DELETE FROM local_facts WHERE account=?', this.account);
      await tx.runAsync('INSERT OR IGNORE INTO local_memory_restore_block(account) VALUES(?)', this.account);
    });
  }

  private async requireActiveAccount(db: MemoryDatabase): Promise<void> {
    const rows = await db.getAllAsync('SELECT 1 FROM local_memory_restore_block WHERE account=?', this.account);
    if (rows.length) throw Error('Account memory erased');
  }

  private async readFacts(db: MemoryDatabase, key?: string): Promise<Fact[]> {
    const sql = 'SELECT key,value,revision,deleted FROM local_facts WHERE account=?';
    const rows = key === undefined
      ? await db.getAllAsync<Row>(sql, this.account)
      : await db.getAllAsync<Row>(sql + ' AND key=?', this.account, key);
    return rows.map(row => ({...row, deleted: Boolean(row.deleted)}));
  }

  private async writeFact(db: MemoryDatabase, fact: Fact): Promise<void> {
    await db.runAsync(
      'INSERT INTO local_facts(account,key,value,revision,deleted) VALUES(?,?,?,?,?) ON CONFLICT(account,key) DO UPDATE SET value=excluded.value,revision=excluded.revision,deleted=excluded.deleted',
      this.account, fact.key, fact.value, fact.revision, Number(fact.deleted),
    );
  }
}
