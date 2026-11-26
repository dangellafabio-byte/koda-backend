// Dedicated offline entry point. The normal application never imports this file.
import { useState } from 'react';
import { registerRootComponent } from 'expo';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import * as SQLite from 'expo-sqlite';
import { Button, ScrollView, Text } from 'react-native';
import { nativeMemoryTestPlatform } from './lib/localMemoryNative';
import { localItalianEngine } from './lib/localMemory/memoryLocalItalian';
import { appleEngine } from './lib/localMemory/memoryApple';

async function verifyNativeMemory() {
  const {apple, directory, open} = await nativeMemoryTestPlatform();
  const account = 'synthetic-' + Crypto.randomUUID();
  const keyName = 'ollenya_memory_' + await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, account);
  const filename = keyName + '.db';
  const output = ['Directory locale esclusa dal backup del sistema.'];
  const first = await open(account);
  try {
    await first.store.change({kind: 'set', key: 'friend.teo', value: 'amico', expectedRevision: 0, confirmed: true});
    await first.close();

    const wrongKey = await SQLite.openDatabaseAsync(filename, {useNewConnection: true}, directory);
    try {
      const random = await Crypto.getRandomBytesAsync(32);
      const wrongHex = Array.from(random, byte => byte.toString(16).padStart(2, '0')).join('');
      await wrongKey.execAsync(`PRAGMA key = "x'${wrongHex}'"`);
      const rejected = await wrongKey.getAllAsync('SELECT COUNT(*) FROM local_facts')
        .then(() => false, () => true);
      if (!rejected) throw Error('Wrong key unexpectedly read the test database');
    } finally {
      await wrongKey.closeAsync();
    }

    const reopened = await open(account);
    try {
      const [fact] = await reopened.store.list();
      if (fact?.value !== 'amico') throw Error('Synthetic fact missing after reopen');
    } finally {
      await reopened.close();
    }
    output.push('SQLCipher: rilevato, chiave errata respinta, rilettura con chiave corretta riuscita.');

    await SecureStore.deleteItemAsync(keyName);
    const rejectedMissingKey = await open(account).then(async handle => {
      await handle.close();
      return false;
    }, error => error instanceof Error && error.message === 'Recovery required: missing key');
    if (!rejectedMissingKey) throw Error('Missing key check failed');
    output.push('SecureStore: chiave mancante rilevata senza rigenerazione.');
  } finally {
    await first.close();
    await SQLite.deleteDatabaseAsync(filename, directory);
    await SecureStore.deleteItemAsync(keyName);
  }

  const baseline = await localItalianEngine.propose({utterance: 'Abito a Milano.', context: []});
  if (!Array.isArray(baseline) || baseline[0]?.key !== 'home.city') {
    throw Error('Common local memory engine failed');
  }
  output.push('Motore locale comune: estrazione di un fatto sintetico verificata.');
  const capabilities = await apple?.capabilities();
  if (apple && capabilities?.available && capabilities.italian && capabilities.onDevice && capabilities.ready) {
    const start = performance.now();
    const proposals = await appleEngine(apple).propose({utterance: 'Teo è un mio amico.', context: []});
    const count = Array.isArray(proposals) ? proposals.length : 0;
    const elapsedMs = Math.round(performance.now() - start);
    output.push(`Apple Foundation Models disponibile in italiano. Proposte validate: ${count}. Durata: ${elapsedMs} ms.`);
  }
  return output.join('\n\n');
}

function NativeMemorySmoke() {
  const [result, setResult] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <ScrollView contentContainerStyle={{padding: 32, paddingTop: 90}}>
      <Button title="Esegui verifica locale" disabled={busy} onPress={async () => {
        setBusy(true);
        setResult('');
        try {
          setResult(await verifyNativeMemory());
        } catch {
          setResult('Verifica interrotta. La memoria sperimentale resta disattivata.');
        } finally {
          setBusy(false);
        }
      }}/>
      <Text selectable style={{marginTop: 24}}>{result}</Text>
    </ScrollView>
  );
}

registerRootComponent(NativeMemorySmoke);
