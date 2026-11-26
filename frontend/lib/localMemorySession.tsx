import Constants from 'expo-constants';
import * as Crypto from 'expo-crypto';
import React, { createContext, useCallback, useContext, useLayoutEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { api } from './api';
import { useAuth } from './auth';
import { getAuthToken } from './authToken';
import type { Change, Fact } from './localMemory/memoryCore';
import { ConversationMemory, type Turn } from './localMemory/memoryConversation';
import type { MemoryStore } from './localMemory/memoryStore';
import { bindLocalObservation } from './localMemory/memoryDispatch';
import { prepareImportPreview, type ImportPreview } from './localMemory/memoryMigration';
import { localItalianEngine } from './localMemory/memoryLocalItalian';
import { conversationEngine } from './localMemory/memoryApple';

import {createBackup} from './localMemory/memoryBackup';
import {portableCrypto, maxBackupFileBytes} from './localMemoryPortable';
import {encodeBase64} from 'tweetnacl-util';
import {Directory, File} from 'expo-file-system';

type Handle = {store: MemoryStore; close(): Promise<void>};
type Session = {account: string; token: string; handle: Handle; memory: ConversationMemory};
type Snapshot = {session: Session; pending: Change[]; facts: Fact[]; legacy: ImportPreview[]};
type Mode = 'text' | 'ptt' | 'hands-free';
type MemoryView = {
  enabled: boolean;
  ready: boolean;
  pending: Change[];
  facts: Fact[];
  beginTurn(mode: Mode, ephemeral: boolean): (text: string) => void;
  confirm(change: Change): Promise<void>;
  dismiss(change: Change): void;
  correct(fact: Fact, value: string): Promise<void>;
  forget(fact: Fact): Promise<void>;
  legacy: ImportPreview[];
  loadLegacy(): Promise<void>;
  deviceText: boolean;
  deviceVoice: boolean;
  converseOnDevice(text: string, voice?: boolean): Promise<{user_entry: import('./api').TimelineEntry; ai_entry: import('./api').TimelineEntry; audio_mp3?: string}>;
  exportFile(): Promise<string>;
  restoreFile(key: string): Promise<void>;
  importLegacy(item: ImportPreview): Promise<void>;
};
const noop = () => {};
const unavailable = async () => { throw Error('Local memory unavailable'); };
const Context = createContext<MemoryView>({
  enabled: false, ready: false, pending: [], facts: [], beginTurn: () => noop,
  confirm: unavailable, correct: unavailable, forget: unavailable, dismiss: noop,
  deviceVoice: false, deviceText: false, converseOnDevice: unavailable, exportFile: unavailable, restoreFile: unavailable, legacy: [], loadLegacy: unavailable, importLegacy: unavailable,
});

export const useLocalMemory = () => useContext(Context);

export function LocalMemoryProvider({children}: {children: React.ReactNode}) {
  const enabled = Constants.expoConfig?.extra?.ollenyaLocalMemoryReview === true &&
    (Platform.OS === 'ios' || Platform.OS === 'android');
  const {user, loading} = useAuth();
  const account = !loading && enabled ? user?.email.trim().toLowerCase() : undefined;
  const token = account ? getAuthToken() : null;
  const active = useRef<Session | null>(null);
  const barrier = useRef<Promise<void>>(Promise.resolve());
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const isCurrent = useCallback((session: Session) => (
    active.current === session && getAuthToken() === session.token
  ), []);

  useLayoutEffect(() => {
    if (!account || account === 'dev@koda.local' || !token) return;
    let cancelled = false;
    const starting = barrier.current.then(async () => {
      if (cancelled || getAuthToken() !== token) return;
      const {nativeMemoryTestPlatform} = await import('./localMemoryNative');
      const {open, apple} = await nativeMemoryTestPlatform();
      if (cancelled || getAuthToken() !== token) return;
      const handle = await open(account);
      try {
        const facts = await handle.store.list();
        if (cancelled || getAuthToken() !== token) {
          await handle.close();
          return;
        }
        const memory = new ConversationMemory({account, list: () => handle.store.list()}, conversationEngine(localItalianEngine, apple));
        const session = {account, token, handle, memory};
        active.current = session;
        setSnapshot({session, pending: [], facts, legacy: []});
      } catch (error) {
        await handle.close();
        throw error;
      }
    }).catch(() => {});
    return () => {
      cancelled = true;
      const session = active.current;
      active.current = null;
      session?.memory.invalidate();
      setSnapshot(null);
      barrier.current = starting.then(() => session?.handle.close()).catch(() => {});
    };
  }, [account, token]);

  const beginTurn = useCallback((mode: Mode, ephemeral: boolean) => {
    const session = active.current;
    if (ephemeral || !session || !isCurrent(session)) return noop;
    return bindLocalObservation(() => isCurrent(session), text => {
      const turn: Turn = {account: session.account, id: '', mode, ephemeral: false, text};
      void session.memory.proposals(turn).then(changes => {
        if (!changes.length || !isCurrent(session)) return;
        setSnapshot(current => {
          if (!current || current.session !== session || !isCurrent(session)) return current;
          const keys = new Set(changes.map(change => change.key));
          return {...current, pending: [...changes, ...current.pending.filter(c => !keys.has(c.key))].slice(0, 12)};
        });
      });
    });
  }, [isCurrent]);

  const commit = async (session: Session, change: Change) => {
    if (!isCurrent(session)) throw Error('Local memory session expired');
    await session.handle.store.change(change);
    const facts = await session.handle.store.list();
    if (!isCurrent(session)) return;
    setSnapshot(current => current?.session === session
      ? {...current, facts, pending: current.pending.filter(pending => pending.key !== change.key)}
      : current);
  };
  const visible = snapshot && snapshot.session.account === account &&
    snapshot.session.token === token && isCurrent(snapshot.session) ? snapshot : null;

  return <Context.Provider value={{
    enabled,
    ready: !!visible,
    facts: visible?.facts.filter(fact => !fact.deleted) ?? [],
    pending: visible?.pending ?? [],
    beginTurn,
    legacy: visible?.legacy ?? [],
    loadLegacy: async () => {
      const session = visible?.session;
      if (!session || !isCurrent(session)) throw Error('Local memory session expired');
      const {candidates} = await api.listLocalMemoryImport(session.token);
      if (!isCurrent(session)) return;
      const local = await session.handle.store.list();
      const legacy = await prepareImportPreview(candidates, local,
        value => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, value));
      if (!isCurrent(session)) return;
      setSnapshot(current => current?.session === session ? {...current, legacy} : current);
    },
    deviceText: enabled && Constants.expoConfig?.extra?.ollenyaDeviceText === true,
    deviceVoice: enabled && Constants.expoConfig?.extra?.ollenyaDeviceVoice === true,
    converseOnDevice: async (text, voice = false) => {
      const session = visible?.session;
      if (!session || !isCurrent(session)) throw Error('Local memory unavailable');
      const context = await session.memory.context({account: session.account, id: '', mode: voice ? 'ptt' : 'text', ephemeral: false, text});
      if (!isCurrent(session)) throw Error('Session expired');
      const response = await api.deviceMemoryText(text, context, session.token, voice);
      if (!isCurrent(session)) throw Error('Session expired');
      return response;
    },
    exportFile: async () => {
      const session = visible?.session;
      if (!session || !isCurrent(session)) throw Error('Session expired');
      const key = encodeBase64(await Crypto.getRandomBytesAsync(32));
      const archive = await createBackup(session.account, await session.handle.store.list(),
        portableCrypto(key, Crypto.getRandomBytesAsync));
      if (!isCurrent(session)) throw Error('Session expired');
      const directory = await Directory.pickDirectoryAsync();
      if (!isCurrent(session)) throw Error('Session expired');
      const file = directory.createFile('ollenya-' + Crypto.randomUUID() + '.txt', 'text/plain');
      file.write(archive);
      return key;
    },
    restoreFile: async key => {
      const session = visible?.session;
      if (!session || !isCurrent(session)) throw Error('Session expired');
      const crypto = portableCrypto(key, Crypto.getRandomBytesAsync);
      const file = await File.pickFileAsync(undefined, 'text/plain');
      if (Array.isArray(file) || !file.size || file.size > maxBackupFileBytes) throw Error('Invalid file');
      const archive = await file.text();
      if (!isCurrent(session)) throw Error('Session expired');
      await session.handle.store.restoreFreshBackup(archive, crypto);
      const facts = await session.handle.store.list();
      if (isCurrent(session)) setSnapshot(current => current?.session === session
        ? {...current, facts, legacy: [], pending: []} : current);
    },
    importLegacy: async item => {
      const session = visible?.session;
      if (!session || !isCurrent(session) || !visible.legacy.includes(item)) throw Error('Import preview expired');
      await session.handle.store.importApproved([{...item, approved: true}]);
      const facts = await session.handle.store.list();
      if (!isCurrent(session)) return;
      setSnapshot(current => current?.session === session
        ? {...current, facts, legacy: current.legacy.filter(candidate => candidate.key !== item.key)}
        : current);
    },
    confirm: async change => {
      if (!visible || !visible.pending.includes(change)) throw Error('Local memory proposal expired');
      await commit(visible.session, {...change, confirmed: true});
    },
    dismiss: change => {
      if (!visible || !isCurrent(visible.session)) return;
      setSnapshot(current => current?.session === visible.session
        ? {...current, pending: current.pending.filter(pending => pending !== change)}
        : current);
    },
    correct: async (fact, value) => {
      if (!visible || fact.deleted || !visible.facts.includes(fact)) throw Error('Local memory fact expired');
      await commit(visible.session, {key: fact.key, value, kind: 'set', expectedRevision: fact.revision, confirmed: true});
    },
    forget: async fact => {
      if (!visible || !visible.facts.includes(fact)) throw Error('Local memory fact expired');
      await commit(visible.session, {key: fact.key, kind: 'forget', expectedRevision: fact.revision, confirmed: true});
    },
  }}>{children}</Context.Provider>;
}
