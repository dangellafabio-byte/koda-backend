import Constants from 'expo-constants';
import * as Crypto from 'expo-crypto';
import { File } from 'expo-file-system';
import { requireOptionalNativeModule } from 'expo';
import * as SecureStore from 'expo-secure-store';
import * as SQLite from 'expo-sqlite';
import { Platform } from 'react-native';
import type { AppleBridge } from './localMemory/memoryApple';
import { createExpoMemoryInitializer } from './localMemory/memoryExpoPlatform';

interface LocalDirectory {
  prepareDatabaseDirectory(): Promise<string>;
}

export async function nativeMemoryTestPlatform() {
  if (Constants.expoConfig?.extra?.ollenyaNativeCandidate !== true) {
    throw Error('Dedicated native candidate required');
  }
  const apple = Platform.OS === 'ios'
    ? requireOptionalNativeModule<LocalDirectory & AppleBridge>('OllenyaMemoryApple')
    : null;
  const directoryModule = Platform.OS === 'android'
    ? requireOptionalNativeModule<LocalDirectory>('OllenyaMemoryAndroid')
    : apple;
  if (!directoryModule) throw Error('Missing native memory directory module');
  const directory = await directoryModule.prepareDatabaseDirectory();
  if (!directory.startsWith('file:///')) throw Error('Invalid local database directory');

  const open = createExpoMemoryInitializer({
    crypto: {
      digestStringAsync: (_, value) => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, value),
      getRandomBytesAsync: Crypto.getRandomBytesAsync,
    },
    secure: SecureStore,
    sqlite: {defaultDatabaseDirectory: directory, openDatabaseAsync: SQLite.openDatabaseAsync},
    fileExists: async uri => new File(uri).exists,
  });

  return {apple, directory, open};
}
