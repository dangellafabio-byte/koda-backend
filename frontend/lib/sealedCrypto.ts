/**
 * Sealed (Zero-Knowledge) Encryption — Modalità Confessionale
 * =============================================================
 * Usa NaCl secretbox (XSalsa20 + Poly1305) per cifrare i messaggi
 * con una chiave derivata dalla "Parola Segreta" dell'utente.
 *
 * Filosofia:
 *  - La parola segreta non lascia mai il dispositivo (salvata in SecureStore).
 *  - Ogni messaggio è cifrato CLIENT-SIDE prima dell'invio.
 *  - Il backend riceve solo {nonce, ciphertext} + la chiave volatile passata
 *    in un header per UN singolo round-trip (la chiave NON viene loggata né
 *    salvata; vive in RAM solo per il tempo della chiamata a Claude).
 *  - La risposta di Claude torna cifrata col MEDESIMO key+nonce schema.
 *  - Nessun database persiste mai testo in chiaro o cifrato.
 */
import nacl from "tweetnacl";
import naclUtil from "tweetnacl-util";
import * as SecureStore from "expo-secure-store";
import * as Crypto from "expo-crypto";
import { Platform } from "react-native";

const SECRET_WORD_KEY = "amico_secret_word_v1";
const SALT_KEY = "amico_secret_salt_v1";
// Pseudo-PBKDF2 con SHA-256 chained — più rounds = più sicuro.
// 100k è un buon compromesso (~1-2s su iPhone moderno).
const KDF_ROUNDS = 100000;

/* ------------------------------------------------------------ */
/* Utilities                                                     */
/* ------------------------------------------------------------ */

function utf8ToBytes(s: string): Uint8Array {
  return naclUtil.decodeUTF8(s);
}

function bytesToUtf8(b: Uint8Array): string {
  return naclUtil.encodeUTF8(b);
}

function bytesToB64(b: Uint8Array): string {
  return naclUtil.encodeBase64(b);
}

function b64ToBytes(s: string): Uint8Array {
  return naclUtil.decodeBase64(s);
}

async function sha256Bytes(data: Uint8Array): Promise<Uint8Array> {
  // expo-crypto operates on strings; we convert bytes <-> base64.
  const b64 = bytesToB64(data);
  const hex = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    b64,
    { encoding: Crypto.CryptoEncoding.HEX }
  );
  // Hex -> bytes
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/* ------------------------------------------------------------ */
/* Storage backend — SecureStore (iOS/Android) / localStorage (web) */
/* ------------------------------------------------------------ */

const isWeb = Platform.OS === "web";

async function storeGet(key: string, opts: SecureStore.SecureStoreOptions = {}): Promise<string | null> {
  if (isWeb) {
    try {
      return typeof window !== "undefined" ? window.localStorage.getItem(key) : null;
    } catch {
      return null;
    }
  }
  return await SecureStore.getItemAsync(key, opts);
}

async function storeSet(key: string, value: string, opts: SecureStore.SecureStoreOptions = {}): Promise<void> {
  if (isWeb) {
    try {
      if (typeof window !== "undefined") window.localStorage.setItem(key, value);
    } catch {}
    return;
  }
  await SecureStore.setItemAsync(key, value, opts);
}

async function storeDel(key: string): Promise<void> {
  if (isWeb) {
    try {
      if (typeof window !== "undefined") window.localStorage.removeItem(key);
    } catch {}
    return;
  }
  try {
    await SecureStore.deleteItemAsync(key);
  } catch {}
}

/* ------------------------------------------------------------ */
/* Secret Word storage                                           */
/* ------------------------------------------------------------ */

export async function getSalt(): Promise<Uint8Array> {
  let salt = await storeGet(SALT_KEY);
  if (!salt) {
    const raw = await Crypto.getRandomBytesAsync(16);
    salt = bytesToB64(raw);
    await storeSet(SALT_KEY, salt);
  }
  return b64ToBytes(salt);
}

export async function setSecretWord(
  word: string,
  options: { biometric?: boolean } = {}
): Promise<void> {
  const trimmed = (word || "").trim();
  if (trimmed.length < 4) {
    throw new Error("La Parola Segreta deve avere almeno 4 caratteri.");
  }
  // Touch the salt so it's stable forever.
  await getSalt();
  const opts: SecureStore.SecureStoreOptions = {
    keychainAccessible: SecureStore.WHEN_UNLOCKED,
  };
  if (options.biometric && !isWeb) {
    opts.requireAuthentication = true;
    opts.authenticationPrompt = "Sblocca la Confessione";
  }
  await storeSet(SECRET_WORD_KEY, trimmed, opts);
}

export async function hasSecretWord(): Promise<boolean> {
  try {
    const v = await storeGet(SECRET_WORD_KEY);
    return !!v;
  } catch {
    return true;
  }
}

export async function getSecretWord(opts: { biometric?: boolean } = {}): Promise<string | null> {
  try {
    const so: SecureStore.SecureStoreOptions = {};
    if (opts.biometric && !isWeb) {
      so.requireAuthentication = true;
      so.authenticationPrompt = "Sblocca la Confessione";
    }
    return (await storeGet(SECRET_WORD_KEY, so)) || null;
  } catch (e) {
    console.warn("[sealedCrypto] getSecretWord failed:", e);
    return null;
  }
}

export async function clearSecretWord(): Promise<void> {
  await storeDel(SECRET_WORD_KEY);
  await storeDel(SALT_KEY);
}

/* ------------------------------------------------------------ */
/* Key Derivation Function (PBKDF-light: SHA-256 chain)         */
/* ------------------------------------------------------------ */

/**
 * Deriva una chiave 32-byte a partire da (parola, salt) via SHA-256 chained.
 * Non è PBKDF2 standard ma fornisce work-factor configurabile (100k rounds)
 * sufficiente per questo use-case (offline brute-force resistance).
 */
export async function deriveKey(passphrase: string, salt: Uint8Array): Promise<Uint8Array> {
  const start = Date.now();
  const passBytes = utf8ToBytes(passphrase);
  // Mixiamo salt+pass nel primo round
  let buf = new Uint8Array(passBytes.length + salt.length);
  buf.set(passBytes, 0);
  buf.set(salt, passBytes.length);
  let key = await sha256Bytes(buf);
  // Iteriamo. Per non spendere troppo tempo (siamo in JS) usiamo 100k rounds
  // ma la chain è SHA-256(prev || pass || salt) per evitare stati banali.
  for (let i = 1; i < KDF_ROUNDS; i++) {
    const next = new Uint8Array(key.length + passBytes.length + salt.length);
    next.set(key, 0);
    next.set(passBytes, key.length);
    next.set(salt, key.length + passBytes.length);
    key = await sha256Bytes(next);
    // Yield ogni 5000 iter per non bloccare l'event loop.
    if (i % 5000 === 0) {
      await new Promise<void>((r) => setTimeout(r, 0));
    }
  }
  console.log(`[sealedCrypto] KDF done in ${Date.now() - start}ms`);
  return key;
}

/* ------------------------------------------------------------ */
/* Encrypt / Decrypt (NaCl secretbox)                           */
/* ------------------------------------------------------------ */

export type SealedPayload = {
  ciphertext: string; // base64
  nonce: string; // base64
};

export async function sealText(plaintext: string, key: Uint8Array): Promise<SealedPayload> {
  const nonceBytes = await Crypto.getRandomBytesAsync(nacl.secretbox.nonceLength);
  const ct = nacl.secretbox(utf8ToBytes(plaintext), nonceBytes, key);
  return { ciphertext: bytesToB64(ct), nonce: bytesToB64(nonceBytes) };
}

export function unsealText(payload: SealedPayload, key: Uint8Array): string | null {
  try {
    const ct = b64ToBytes(payload.ciphertext);
    const nonce = b64ToBytes(payload.nonce);
    const out = nacl.secretbox.open(ct, nonce, key);
    if (!out) return null;
    return bytesToUtf8(out);
  } catch {
    return null;
  }
}

export function keyToBase64(key: Uint8Array): string {
  return bytesToB64(key);
}

export function keyFromBase64(b64: string): Uint8Array {
  return b64ToBytes(b64);
}

/* ------------------------------------------------------------ */
/* High-level helper: cache della key derivata in memoria        */
/* ------------------------------------------------------------ */
let _cachedKey: Uint8Array | null = null;
let _cachedAt = 0;
const KEY_CACHE_MS = 5 * 60 * 1000; // 5 minuti

export async function getSessionKey(opts: { biometric?: boolean } = {}): Promise<Uint8Array | null> {
  const now = Date.now();
  if (_cachedKey && now - _cachedAt < KEY_CACHE_MS) return _cachedKey;
  const word = await getSecretWord(opts);
  if (!word) return null;
  const salt = await getSalt();
  const key = await deriveKey(word, salt);
  _cachedKey = key;
  _cachedAt = now;
  return key;
}

export function forgetSessionKey() {
  _cachedKey = null;
  _cachedAt = 0;
}

/* ------------------------------------------------------------ */
/* Biometric availability check                                  */
/* ------------------------------------------------------------ */
export async function biometricAvailable(): Promise<boolean> {
  if (Platform.OS === "web") return false;
  try {
    const LA = await import("expo-local-authentication");
    const has = await LA.hasHardwareAsync();
    if (!has) return false;
    const enrolled = await LA.isEnrolledAsync();
    return enrolled;
  } catch {
    return false;
  }
}
