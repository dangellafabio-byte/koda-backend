/**
 * Porta Fuori — Ponte one-shot fra Confessionale e conversazione normale.
 *
 * Architettura Opzione A (massima privacy):
 *   1. Il backend ci consegna SOLO i ciphertext della stanza segreta
 *      (endpoint /api/confessional/history). La parola segreta NON viene
 *      mai trasmessa al server.
 *   2. Il client deriva la chiave dalla parola segreta (PBKDF lato device,
 *      sealedCrypto.deriveKey) e decritta tutti gli entry IN MEMORIA.
 *   3. L'utente conferma se vuole davvero "portare fuori" quei contenuti.
 *   4. Solo allora il backend riceve i secrets DECRITTATI in chiaro come
 *      `bridged_secrets` nel corpo di /api/converse — usati per UN solo
 *      turno e poi cancellati (ephemeral forzato lato server).
 *
 * Sicurezza:
 *   - I secrets in chiaro vivono SOLO in RAM del client, in una closure
 *     che viene azzerata dopo l'uso (vedi `consumeBridge()`).
 *   - Niente AsyncStorage, niente SecureStore, niente log.
 */
import { api } from "./api";
import {
  deriveKey,
  getSalt,
  unsealText,
  type SealedPayload,
} from "./sealedCrypto";

/* ------------------------------------------------------------ */
/* Stato in RAM: ponte aperto (decrittato e pronto da consumare) */
/* ------------------------------------------------------------ */

let _bridgeSecrets: string[] | null = null;
let _bridgeOpenedAt: number = 0;
const BRIDGE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minuti max

export type DecryptedEntry = {
  id: string;
  role: "user" | "ai";
  text: string;
  ts: string;
};

/**
 * Decritta tutto lo storico confessionale usando la parola segreta.
 * Restituisce gli entry decifrati (utente + Koda) in ordine cronologico.
 * Se la parola è sbagliata (nessun entry decifrato), ritorna null.
 */
export async function decryptConfessionalHistory(
  secretWord: string
): Promise<DecryptedEntry[] | null> {
  const word = (secretWord || "").trim();
  if (!word) return null;
  // 1. Deriva la key dalla parola
  const salt = await getSalt();
  const key = await deriveKey(word, salt);
  // 2. Fetcha gli entry cifrati dal backend
  const resp = await api.confessionalHistory(200);
  const items = resp?.entries || [];
  if (items.length === 0) return [];
  // 3. Decifra UNO PER UNO. Se nessun entry decritta → parola sbagliata.
  const out: DecryptedEntry[] = [];
  for (const it of items) {
    const sealed: SealedPayload = { ciphertext: it.ciphertext, nonce: it.nonce };
    const txt = unsealText(sealed, key);
    if (txt) {
      out.push({ id: it.id, role: it.role, text: txt, ts: it.ts });
    }
  }
  // Se abbiamo entry cifrati ma NESSUNO è decifrato → parola sbagliata.
  if (items.length > 0 && out.length === 0) return null;
  return out;
}

/**
 * "Apre il ponte" caricando in RAM i contenuti decifrati. Da chiamare
 * SUBITO PRIMA del prossimo turno di /converse. Verranno consumati e
 * dimenticati dopo un singolo uso (o dopo 5 minuti).
 */
export function openBridge(entries: DecryptedEntry[]): void {
  // Solo i testi (no metadata) — riducono ulteriormente la superficie.
  _bridgeSecrets = entries
    .map((e) => `[${e.role === "user" ? "Io" : "Koda"}] ${e.text}`)
    .filter((s) => s && s.trim().length > 0);
  _bridgeOpenedAt = Date.now();
}

/**
 * Consuma il ponte: ritorna i secrets E LI CANCELLA dalla RAM.
 * Da chiamare SUBITO PRIMA della call a /converse, e una volta sola.
 * Se il ponte è scaduto (5 min) o non aperto, ritorna null.
 */
export function consumeBridge(): string[] | null {
  if (!_bridgeSecrets) return null;
  if (Date.now() - _bridgeOpenedAt > BRIDGE_TIMEOUT_MS) {
    closeBridge();
    return null;
  }
  const out = _bridgeSecrets;
  closeBridge();
  return out;
}

export function isBridgeOpen(): boolean {
  if (!_bridgeSecrets) return false;
  if (Date.now() - _bridgeOpenedAt > BRIDGE_TIMEOUT_MS) {
    closeBridge();
    return false;
  }
  return true;
}

/**
 * Chiude il ponte cancellando i secrets dalla RAM. Da chiamare se l'utente
 * annulla, esce dalla home, o passa al confessionale.
 */
export function closeBridge(): void {
  // Sovrascrive con stringhe vuote prima di nullare — extra paranoia.
  if (_bridgeSecrets) {
    for (let i = 0; i < _bridgeSecrets.length; i++) {
      _bridgeSecrets[i] = "";
    }
  }
  _bridgeSecrets = null;
  _bridgeOpenedAt = 0;
}
