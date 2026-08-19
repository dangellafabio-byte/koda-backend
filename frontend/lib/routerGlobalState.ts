/**
 * lib/routerGlobalState.ts
 *
 * === PUNTO 3 — STATO GLOBALE DEL ROUTER FREE/PREMIUM (Fabio 2026-08-17) ===
 *
 * Contesto:
 * Il router condizionale in app/index.tsx decide se un utente free viene
 * rediretto a /lascia-andare o se un utente Premium resta su Koda conv.
 * Il ref locale al componente <Taccuino> non basta perché non sopravvive
 * al re-mount della Home page (causato da TrialWatcher polling, AuthProvider
 * refresh, ripristino da background). Serve una memoria a livello di
 * modulo che sopravviva al re-mount.
 *
 * Semantica:
 * - Memorizza il `profileId` per cui la decisione di routing è già stata
 *   presa in questa sessione app.
 * - Se il profileId corrente coincide con quello memorizzato, il router
 *   NON ridecide (evita il loop di redirect).
 * - Se il profileId cambia (nuovo login, switch account) il router
 *   ridecide correttamente.
 * - Su `signOut()` (lib/auth.tsx) il flag viene resettato esplicitamente
 *   per igiene semantica: signOut conclude la sessione, gli stati globali
 *   associati devono azzerarsi.
 *
 * NON è persistito (AsyncStorage): al prossimo cold boot il modulo si
 * ricarica → memoria vuota → il redirect ri-scatta correttamente.
 */

let _lastDecidedProfileId: string | null = null;

/** Restituisce il profileId per cui il router ha già preso una decisione,
 *  oppure null se nessuna decisione è stata presa in questa sessione. */
export function getLastDecidedProfileId(): string | null {
  return _lastDecidedProfileId;
}

/** Marca una decisione presa per il profileId dato.
 *  Chiamato dal router condizionale in app/index.tsx dopo aver deciso
 *  (redirect a /lascia-andare per free, stay per paid). */
export function markRouterDecided(profileId: string | null): void {
  _lastDecidedProfileId = profileId;
}

/** Azzera lo stato del router. Chiamato da lib/auth.tsx:signOut() così
 *  la sessione successiva ridecide fresh, senza residui della precedente. */
export function resetRouterGlobalState(): void {
  _lastDecidedProfileId = null;
}
