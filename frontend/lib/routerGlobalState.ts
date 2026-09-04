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

// === FIX A (Fabio 2026-08-22) — cache include tier =========================
// PRIMA: la cache memorizzava SOLO profileId. Se un utente cambiava tier
// (via dev panel o RevenueCat), il router NON ridecideva → utente bloccato
// sulla decisione precedente. Esempio: user testa "Simula Premium" (isPaid
// → resta su /), poi "Torna Free" → tier=null ma profileId invariato →
// router non ridecide → resta sulla home come Free (bug segnalato).
// ADESSO: la chiave è `${profileId}:${tier}` così ogni cambio tier
// invalida la cache e il router ridecide correttamente.
let _lastDecidedKey: string | null = null;

/** Restituisce la chiave (profileId:tier) per cui il router ha già preso
 *  una decisione in questa sessione, oppure null. */
export function getLastDecidedKey(): string | null {
  return _lastDecidedKey;
}

/** Marca una decisione presa. Chiamato dal router condizionale in
 *  app/index.tsx dopo aver deciso (redirect a /lascia-andare per free,
 *  stay per paid). La chiave combina profileId e tier così ogni cambio
 *  tier forza una ri-decisione. */
export function markRouterDecided(profileId: string | null, tier: string | null): void {
  _lastDecidedKey = profileId === null ? null : `${profileId}:${tier ?? "free"}`;
}

/** @deprecated Compat: alcuni call-site legacy potrebbero cercare la
 *  vecchia firma. Ritorna solo il profileId estratto dalla chiave. */
export function getLastDecidedProfileId(): string | null {
  if (!_lastDecidedKey) return null;
  const colonIdx = _lastDecidedKey.lastIndexOf(":");
  return colonIdx > 0 ? _lastDecidedKey.slice(0, colonIdx) : _lastDecidedKey;
}

// === PUNTO 2 (Fabio 2026-08-20) — SKIP SPLASH ON REMOUNT ===================
// Il `showSplash` in app/index.tsx parte di default a `true` → al re-mount
// della Home (ad es. dopo che il free user esce da Lascia Andare via X)
// il KodaSplash da 10s riparte, sembrando "l'app che boota di nuovo".
// Con questo flag, dopo il primo splash della sessione, i mount successivi
// della Home partono già con `showSplash=false` → transizione fluida.
//
// Semantica identica a `_lastDecidedProfileId`:
//   - Vive a livello di modulo → sopravvive a unmount+remount di Home
//   - NON è persistito → al cold boot il modulo si ricarica e lo splash
//     si vede di nuovo (comportamento corretto: il splash appartiene
//     all'apertura app, non alla singola visita della Home)
//   - Resettato esplicitamente da resetRouterGlobalState() su signOut
//     (per igiene semantica: nuovo utente → nuova prima impressione)
let _sessionHasShownSplash = false;

/** Restituisce true se il KodaSplash è già stato mostrato in questa
 *  sessione app. La Home lo legge al mount per decidere lo stato iniziale
 *  di `showSplash`. */
export function getSessionHasShownSplash(): boolean {
  return _sessionHasShownSplash;
}

/** Marca il splash come "già mostrato" per la sessione app in corso.
 *  Chiamato quando `setShowSplash(false)` viene invocato (naturalmente al
 *  termine del KodaSplash da 10s, o via skip-splash-after-intro). */
export function markSessionSplashShown(): void {
  _sessionHasShownSplash = true;
}

/** Azzera lo stato del router. Chiamato da lib/auth.tsx:signOut() così
 *  la sessione successiva ridecide fresh, senza residui della precedente.
 *  Azzera anche il flag splash: un nuovo utente merita di rivedere
 *  l'ingresso identitario dell'app (KodaSplash) al primo boot. */
export function resetRouterGlobalState(): void {
  _lastDecidedKey = null;
  _sessionHasShownSplash = false;
}

/** === FIX BUG CACHE TIER IN-SESSIONE (Fabio 2026-08-24) ===================
 *  Reset SOLO della chiave ultima-decisione, senza toccare lo splash flag.
 *  Chiamato dai dev button "Simula Premium" / "Torna Free" quando cambia
 *  il tier a runtime: forza il router Free/Premium a ridecidere con la
 *  nuova chiave, senza far ripartire lo splash da 10s (che vive a sessione,
 *  non a decisione routing).
 */
export function resetLastDecidedKey(): void {
  _lastDecidedKey = null;
}

// === FIX 2026-08-28 v65.13 — SESSIONE VOCE ATTIVA GLOBAL FLAG ===============
// Bug fatale iOS: mid-conversazione, un poll di /api/profile poteva
// restituire tier=free (transient DB failure / cache poison) → il router
// KODA_ROUTER faceva `router.replace('/lascia-andare')` sovrascrivendo
// la UI attiva della voce durante il turno di Koda. L'utente vedeva
// due schermate overlappate e il flusso vocale si interrompeva.
//
// Difesa: mentre `convActive === true` (utente in sessione hands-free
// live) NESSUN router.replace è consentito verso /lascia-andare o simili
// downgrade paths. La decisione viene deferita: quando la sessione voce
// finisce, il router ridecide con dati freschi.
//
// Flag a livello modulo perché la useEffect del router è dichiarata PRIMA
// del state `convActive` nel componente <Taccuino> → il ref locale
// non è ancora disponibile in quel punto. Il flag qui è pilotato dal
// setter setConvVoiceActive() invocato ogni volta che convActive cambia.
let _convVoiceActive = false;

export function setConvVoiceActive(active: boolean): void {
  _convVoiceActive = !!active;
}

export function isConvVoiceActive(): boolean {
  return _convVoiceActive;
}

// === FIX 2026-08-28 v65.13 — TIER STABILITY GRACE ===========================
// Il router non deve reagire immediatamente a un cambio tier paid→free.
// Memorizziamo l'ultimo tier "paid" osservato e il timestamp. Se ora
// vediamo free ma abbiamo visto paid meno di GRACE_MS fa, deferiamo la
// decisione (aspetta il prossimo fetch, magari è un transient).
let _lastPaidTierSeenAt: number | null = null;

export function markPaidTierSeen(): void {
  _lastPaidTierSeenAt = Date.now();
}

export function isPaidTierRecent(graceMs: number = 60_000): boolean {
  if (_lastPaidTierSeenAt === null) return false;
  return Date.now() - _lastPaidTierSeenAt < graceMs;
}

export function clearPaidTierMemory(): void {
  _lastPaidTierSeenAt = null;
}
