/**
 * KODA — Router decision test suite (Fabio 2026-08-23)
 * ====================================================
 *
 * Test standalone Node.js — nessuna dipendenza esterna.
 * Esegui con: `node tests/routerDecision.test.js`
 *
 * Copre i 10 scenari richiesti dall'utente:
 *   1. Free + V3 completed + network fresh → redirect /lascia-andare
 *   2. Free + V3 completed + cache only → wait (blocca decisione stale)
 *   3. Free + V3 needed + network fresh → redirect /intro-v3
 *   4. Race Bug 1: Free cache stale + Premium network → wait su cache,
 *      poi Intro Premium su network
 *   5. Premium + intro-premium completed → home (stay)
 *   6. Premium + intro-premium needed + V3 needed → salta V3
 *      (mark completed), poi /intro-premium
 *   7. Premium via dev-bypass (mai passato da Free) → mai V3
 *   8. Cambio tier in-session Premium→Free → keyed invalidation →
 *      /lascia-andare
 *   9. fastPathHydrate stale + loadProfile fresh → decisione sempre
 *      su network
 *  10. Disclaimer non accettato → wait su tutti i router
 *  11. showSplash true → wait su tutti i router
 *  12. Path diverso da "/" → wait su tutti (evita loop)
 */

const {
  decideRouterV3,
  decideRouterFreePremium,
  decideRouterIntroPremium,
} = require("../lib/routerDecision.js");

// ============================================================================
// Test runner minimale
// ============================================================================
let passed = 0;
let failed = 0;
const failures = [];

function assertEq(actual, expected, testName, note = "") {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed++;
    console.log(`  ✓ ${testName}${note ? " — " + note : ""}`);
  } else {
    failed++;
    console.log(`  ✗ FAIL: ${testName}`);
    console.log(`      expected: ${JSON.stringify(expected)}`);
    console.log(`      actual:   ${JSON.stringify(actual)}`);
    failures.push(testName);
  }
}

function test(name, fn) {
  console.log(`\n▶ ${name}`);
  fn();
}

// ============================================================================
// Fixtures
// ============================================================================
function baseInput(overrides = {}) {
  return Object.assign(
    {
      pathname: "/",
      profile: { id: "pid-1", subscription_tier: null },
      profileHydrated: "network",
      introV3State: "completed",
      introPremiumState: "completed",
      disclaimerState: "accepted",
      showSplash: false,
      showColorIntro: false,
      hasRedirectedIntroV3: false,
      hasRedirectedFreeUser: false,
      hasRedirectedIntroPremium: false,
      lastV3DecidedKey: null,
      lastFreePremiumDecidedKey: null,
      lastIntroPremiumDecidedKey: null,
    },
    overrides
  );
}

// ============================================================================
// TEST 1: Free + V3 completed + network fresh → redirect /lascia-andare
// ============================================================================
test("Scenario 1: Free + V3 completed + network fresh → /lascia-andare", () => {
  const input = baseInput({
    profile: { id: "pid-1", subscription_tier: null },
    introV3State: "completed",
    profileHydrated: "network",
  });
  const decision = decideRouterFreePremium(input);
  assertEq(decision.kind, "redirect", "kind");
  assertEq(decision.target, "/lascia-andare", "target");
});

// ============================================================================
// TEST 2: Free + V3 completed + cache only → wait
// ============================================================================
test("Scenario 2: Free + cache only (profileHydrated=cache) → wait", () => {
  const input = baseInput({
    profile: { id: "pid-1", subscription_tier: null },
    profileHydrated: "cache",
  });
  const decision = decideRouterFreePremium(input);
  assertEq(decision.kind, "wait", "must wait (no network hydration)");
});

// ============================================================================
// TEST 3: Free + V3 needed + network fresh → redirect /intro-v3
// ============================================================================
test("Scenario 3: Free + V3 needed + network fresh → /intro-v3", () => {
  const input = baseInput({
    profile: { id: "pid-1", subscription_tier: null },
    introV3State: "needed",
    profileHydrated: "network",
  });
  const decision = decideRouterV3(input);
  assertEq(decision.kind, "redirect", "kind");
  assertEq(decision.target, "/intro-v3", "target");
});

// ============================================================================
// TEST 4 (BUG 1): Race cache-stale vs network Premium
// ============================================================================
test("Scenario 4 (BUG 1): fastPathHydrate cache=Free stale + network=Premium", () => {
  // t=0: cache serve profile con tier=null (stale)
  const t0 = baseInput({
    profile: { id: "pid-1", subscription_tier: null },
    profileHydrated: "cache",
    introV3State: "needed",
  });
  const dec0 = decideRouterV3(t0);
  assertEq(dec0.kind, "wait", "t=0 cache stale → V3 must WAIT (would have caused Bug 1)");

  // t=1: network arriva con tier=monthly
  const t1 = baseInput({
    profile: { id: "pid-1", subscription_tier: "monthly" },
    profileHydrated: "network",
    introV3State: "needed",
  });
  const dec1 = decideRouterV3(t1);
  assertEq(dec1.kind, "mark_v3_completed", "t=1 network premium → skip V3");

  // t=2: dopo mark, introV3State diventa "completed" → IntroPremium router
  const t2 = baseInput({
    profile: { id: "pid-1", subscription_tier: "monthly" },
    profileHydrated: "network",
    introV3State: "completed",
    introPremiumState: "needed",
  });
  const dec2 = decideRouterIntroPremium(t2);
  assertEq(dec2.kind, "redirect", "t=2 kind");
  assertEq(dec2.target, "/intro-premium", "t=2 target = /intro-premium (NO V3 shown)");
});

// ============================================================================
// TEST 5: Premium + intro-premium completed → home stay
// ============================================================================
test("Scenario 5: Premium + intro-premium completed → home stay", () => {
  const input = baseInput({
    profile: { id: "pid-1", subscription_tier: "monthly" },
    introV3State: "completed",
    introPremiumState: "completed",
    profileHydrated: "network",
  });
  const decisionFP = decideRouterFreePremium(input);
  assertEq(decisionFP.kind, "stay", "Free/Premium router: stay on Koda conv");

  const decisionIP = decideRouterIntroPremium(input);
  assertEq(decisionIP.kind, "wait", "IntroPremium router: wait (already completed)");
});

// ============================================================================
// TEST 6: Premium + intro-premium needed + V3 needed → salta V3 + intro-premium
// ============================================================================
test("Scenario 6: Premium + V3 needed → mark V3, then /intro-premium", () => {
  // Fase 1: V3 router decide
  const phase1 = baseInput({
    profile: { id: "pid-1", subscription_tier: "annual" },
    introV3State: "needed",
    introPremiumState: "needed",
    profileHydrated: "network",
  });
  const dec1 = decideRouterV3(phase1);
  assertEq(dec1.kind, "mark_v3_completed", "V3 must mark completed for premium");

  // Fase 2: dopo mark, IntroPremium router deve triggerare
  const phase2 = baseInput({
    profile: { id: "pid-1", subscription_tier: "annual" },
    introV3State: "completed",
    introPremiumState: "needed",
    profileHydrated: "network",
  });
  const dec2 = decideRouterIntroPremium(phase2);
  assertEq(dec2.kind, "redirect", "kind");
  assertEq(dec2.target, "/intro-premium", "target");
});

// ============================================================================
// TEST 7: Premium via dev-bypass (mai stato Free prima) → mai V3
// ============================================================================
test("Scenario 7: Premium via dev-bypass (nuovo account) → mai V3", () => {
  // Utente che diventa premium al primo boot (fresh install + bypass)
  const input = baseInput({
    profile: { id: "pid-1", subscription_tier: "monthly" },
    introV3State: "needed", // MAI vista
    introPremiumState: "needed",
    profileHydrated: "network",
  });
  const decV3 = decideRouterV3(input);
  assertEq(decV3.kind, "mark_v3_completed", "V3 router MUST skip (not redirect)");

  // Il chiamante (real code) applicherà markKey e setIntroV3State("completed")
  // Poi il router IntroPremium prende il controllo (Fase 6 sopra).
});

// ============================================================================
// TEST 8: Cambio tier in-session Premium→Free → /lascia-andare
// ============================================================================
test("Scenario 8: Premium → Free in-session (keyed invalidation)", () => {
  // Stato 1: Utente Premium, decisione già presa
  const s1 = baseInput({
    profile: { id: "pid-1", subscription_tier: "monthly" },
    introV3State: "completed",
    introPremiumState: "completed",
    profileHydrated: "network",
    hasRedirectedFreeUser: true,
    lastFreePremiumDecidedKey: "pid-1:monthly",
  });
  const decStay = decideRouterFreePremium(s1);
  assertEq(decStay.kind, "wait", "same key → wait (no redecision)");

  // Stato 2: User clicca "Torna Free" — tier cambia, key cambia
  // Il chiamante RESETTA hasRedirectedFreeUser=false quando la key cambia
  // MA il getLastDecidedKey (module) è ancora "pid-1:monthly"
  const s2 = baseInput({
    profile: { id: "pid-1", subscription_tier: null }, // now free
    introV3State: "completed",
    introPremiumState: "completed",
    profileHydrated: "network",
    hasRedirectedFreeUser: false, // reset by React re-render
    lastFreePremiumDecidedKey: "pid-1:monthly", // old key
  });
  const decRedirect = decideRouterFreePremium(s2);
  assertEq(decRedirect.kind, "redirect", "kind (key changed → redecide)");
  assertEq(decRedirect.target, "/lascia-andare", "target");
});

// ============================================================================
// TEST 9: profileHydrated=cache stale non decide su nessun router
// ============================================================================
test("Scenario 9: profileHydrated=cache → tutti i router WAIT", () => {
  const input = baseInput({
    profile: { id: "pid-1", subscription_tier: "monthly" },
    profileHydrated: "cache",
    introV3State: "needed",
    introPremiumState: "needed",
  });
  assertEq(decideRouterV3(input).kind, "wait", "V3 router");
  assertEq(decideRouterFreePremium(input).kind, "wait", "Free/Premium router");
  assertEq(decideRouterIntroPremium(input).kind, "wait", "IntroPremium router");
});

// ============================================================================
// TEST 10: Disclaimer non accettato → tutti i router WAIT
// ============================================================================
test("Scenario 10: Disclaimer non accettato → tutti WAIT", () => {
  const input = baseInput({
    disclaimerState: "needed",
    profile: { id: "pid-1", subscription_tier: "monthly" },
    introV3State: "needed",
    introPremiumState: "needed",
    profileHydrated: "network",
  });
  assertEq(decideRouterV3(input).kind, "wait", "V3");
  assertEq(decideRouterFreePremium(input).kind, "wait", "Free/Premium");
  assertEq(decideRouterIntroPremium(input).kind, "wait", "IntroPremium");
});

// ============================================================================
// TEST 11: showSplash → tutti i router WAIT
// ============================================================================
test("Scenario 11: showSplash true → tutti WAIT", () => {
  const input = baseInput({
    showSplash: true,
    profile: { id: "pid-1", subscription_tier: "monthly" },
    introV3State: "needed",
    introPremiumState: "needed",
    profileHydrated: "network",
  });
  assertEq(decideRouterV3(input).kind, "wait", "V3");
  assertEq(decideRouterFreePremium(input).kind, "wait", "Free/Premium");
  assertEq(decideRouterIntroPremium(input).kind, "wait", "IntroPremium");
});

// ============================================================================
// TEST 12: Path != "/" → tutti WAIT (evita loop di redirect)
// ============================================================================
test("Scenario 12: pathname='/lascia-andare' → tutti WAIT", () => {
  const input = baseInput({
    pathname: "/lascia-andare",
    profile: { id: "pid-1", subscription_tier: null },
    profileHydrated: "network",
    introV3State: "needed",
  });
  assertEq(decideRouterV3(input).kind, "wait", "V3");
  assertEq(decideRouterFreePremium(input).kind, "wait", "Free/Premium");
  assertEq(decideRouterIntroPremium(input).kind, "wait", "IntroPremium");
});

// ============================================================================
// TEST 13: Utente Free NON deve mai vedere la home reale
//   (verifica di regola trasversale PARTE 3 spec)
// ============================================================================
test("Scenario 13: Free user su '/' → SEMPRE redirect /lascia-andare (mai stay)", () => {
  // Tutti i possibili valori di tier "free"
  const freeStates = [null, undefined, "", "essential", "daily", "plus"];
  for (const tier of freeStates) {
    const input = baseInput({
      profile: { id: "pid-1", subscription_tier: tier },
      profileHydrated: "network",
      introV3State: "completed",
    });
    const decision = decideRouterFreePremium(input);
    assertEq(
      decision.kind === "redirect" && decision.target === "/lascia-andare",
      true,
      `tier=${tier === null ? "null" : tier === undefined ? "undefined" : `'${tier}'`}`
    );
  }
});

// ============================================================================
// TEST 14: Utente Premium NON deve mai vedere V3 (regola trasversale)
// ============================================================================
test("Scenario 14: Paid user su '/' con V3 needed → SEMPRE mark_v3_completed (mai redirect /intro-v3)", () => {
  const paidTiers = ["monthly", "bimonthly", "annual", "unlimited"];
  for (const tier of paidTiers) {
    const input = baseInput({
      profile: { id: "pid-1", subscription_tier: tier },
      profileHydrated: "network",
      introV3State: "needed",
    });
    const decision = decideRouterV3(input);
    assertEq(
      decision.kind === "mark_v3_completed",
      true,
      `tier=${tier}`
    );
  }
});

// ============================================================================
// Report finale
// ============================================================================
console.log(`\n${"=".repeat(70)}`);
console.log(`Risultato: ${passed} PASS, ${failed} FAIL su ${passed + failed} assertions`);
if (failed > 0) {
  console.log(`\nTest FALLITI:`);
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}
console.log(`✅ Tutti i test router hanno superato la verifica.`);
process.exit(0);
