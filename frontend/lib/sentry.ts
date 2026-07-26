/**
 * sentry.ts — STUB NO-OP (v65.1 — 26 luglio 2026)
 *
 * ⚠️  STATO: Sentry TEMPORANEAMENTE DISATTIVATO
 *
 * MOTIVO: il pacchetto `@sentry/react-native` è stato rimosso da package.json
 * il 25 luglio 2026 perché il suo script Xcode `Upload Debug Symbols to Sentry`
 * fa fallire la build iOS EAS senza `SENTRY_AUTH_TOKEN` (che deve essere
 * fornito come EAS Secret dall'utente — non ancora disponibile).
 *
 * Questo file mantiene la stessa API pubblica (`initSentry`, `Sentry.wrap`,
 * `Sentry.captureException`, ...) come no-op, così tutti gli import esistenti
 * continuano a funzionare senza modifiche nel resto del codice.
 *
 * ==== RIATTIVAZIONE FUTURA ====
 * Quando l'utente fornirà il Sentry Auth Token:
 *   1. `yarn add @sentry/react-native@~8` (versione compatibile Expo SDK 54)
 *   2. Aggiungere `SENTRY_AUTH_TOKEN` come EAS Secret via https://expo.dev
 *   3. Sostituire questo file con il vecchio implementato (git history)
 *   4. Rimuovere lo script `postinstall` che pulisce node_modules/@sentry
 */

// eslint-disable-next-line @typescript-eslint/no-unused-vars
type AnyFn = (...args: any[]) => any;

/**
 * Stub Sentry — API identica a `@sentry/react-native` ma no-op.
 * Tutti i metodi sono safe da chiamare, non lanciano, non fanno nulla.
 */
export const Sentry = {
  // HOC wrap — ritorna il componente invariato
  wrap<T>(component: T): T {
    return component;
  },
  // Error capture
  captureException(_error: unknown, _hint?: unknown): string {
    return "";
  },
  captureMessage(_message: string, _level?: string): string {
    return "";
  },
  // Breadcrumbs
  addBreadcrumb(_breadcrumb: unknown): void {
    /* no-op */
  },
  // User / tags / context
  setUser(_user: unknown): void {
    /* no-op */
  },
  setTag(_key: string, _value: unknown): void {
    /* no-op */
  },
  setContext(_name: string, _context: unknown): void {
    /* no-op */
  },
  // Scope
  withScope(callback: (scope: any) => void): void {
    try {
      callback({
        setTag: () => {},
        setContext: () => {},
        setExtra: () => {},
        setUser: () => {},
        setLevel: () => {},
        setFingerprint: () => {},
      });
    } catch {
      /* no-op */
    }
  },
  // Flush / close
  async flush(_timeout?: number): Promise<boolean> {
    return true;
  },
  async close(_timeout?: number): Promise<boolean> {
    return true;
  },
  // Native crash test (dev only)
  nativeCrash(): void {
    /* no-op */
  },
  // Session Replay stub
  getReplay(): null {
    return null;
  },
};

let _warned = false;

/**
 * Inizializza Sentry — attualmente NO-OP.
 * Idempotente e safe.
 */
export function initSentry(): void {
  if (_warned) return;
  _warned = true;
  // Log solo in dev per ricordare che è disattivato
  if (__DEV__) {
    // eslint-disable-next-line no-console
    console.info(
      "[Sentry] STUB attivo — crash reporting DISATTIVATO. Vedi lib/sentry.ts per riattivazione."
    );
  }
}
