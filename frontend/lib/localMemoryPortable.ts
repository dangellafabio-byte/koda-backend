import * as nacl from 'tweetnacl';
import {decodeBase64, encodeBase64, decodeUTF8, encodeUTF8} from 'tweetnacl-util';
import type {BackupCrypto} from './localMemory/memoryBackup';

const prefix = 'OLLENYA-BACKUP-1.';
export const maxBackupFileBytes = 8 * 1024 * 1024;

export function portableCrypto(keyText: string, random: (size: number) => Promise<Uint8Array>): BackupCrypto {
  const key = decodeBase64(keyText.trim());
  if (key.length !== nacl.secretbox.keyLength) throw Error('Invalid recovery key');
  return {
    async seal(plaintext, account) {
      const bytes = decodeUTF8(JSON.stringify([account, plaintext]));
      const nonce = await random(nacl.secretbox.nonceLength);
      const envelope = prefix + encodeBase64(nonce) + '.' + encodeBase64(nacl.secretbox(bytes, nonce, key));
      if (envelope.length > maxBackupFileBytes) throw Error('Backup exceeds file limit');
      return envelope;
    },
    async open(envelope, account) {
      if (!envelope.startsWith(prefix) || envelope.length > maxBackupFileBytes) throw Error('Invalid file');
      const parts = envelope.slice(prefix.length).split('.');
      if (parts.length !== 2) throw Error('Invalid file');
      const bytes = nacl.secretbox.open(decodeBase64(parts[1]), decodeBase64(parts[0]), key);
      if (!bytes) throw Error('Invalid backup');
      const data = JSON.parse(encodeUTF8(bytes));
      if (!Array.isArray(data) || data.length !== 2 || data[0] !== account || typeof data[1] !== 'string') {
        throw Error('Invalid backup account');
      }
      return data[1];
    },
  };
}
