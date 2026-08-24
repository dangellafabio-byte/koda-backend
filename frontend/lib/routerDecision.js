/**
 * KODA — Pure router decision functions (Fabio 2026-08-23)
 * =========================================================
 *
 * Estrazione pura della logica dei 3 router condizionali che vivono
 * come `useEffect` dentro <Taccuino> (app/index.tsx). Serve per
 * testare la logica in isolamento SENZA montare React.
 *
 * REGOLA: queste funzioni devono essere una traduzione FEDELE della
 * logica delle useEffect. Se cambia una guardia lì, cambia qui.
 *
 * Contratto:
 *   Input: RouterInput (uno snapshot dello stato)
 *   Output: Decision { kind: "wait" | "redirect" | "mark_v3_completed" | "stay",
 *                      reason: string,
 *                      target?: string,
 *                      markKey?: string }
 *
 * Le funzioni NON hanno side effect. Non toccano SecureStore, non
 * chiamano router.replace(). Il chiamante applica il risultato.
 */

const PAID_TIERS = new Set(["monthly", "bimonthly", "annual", "unlimited"]);

function isPaidTier(tier) {
  return tier != null && PAID_TIERS.has(tier);
}

function computeKey(profile) {
  if (!profile || !profile.id) return null;
  const tier = profile.subscription_tier || null;
  return `${profile.id}:${tier ?? "free"}`;
}

/**
 * Router V3 — decide se avviare l'Intro V3 (Free) o marcarla come
 * "completata" (Premium al primo boot).
 *
 * Traduzione fedele di app/index.tsx righe ~979-1050.
 */
function decideRouterV3(input) {
  if (input.pathname !== "/")
    return { kind: "wait", reason: "not on / pathname" };
  if (input.introV3State !== "needed")
    return { kind: "wait", reason: `introV3State=${input.introV3State}` };
  if (!input.profile)
    return { kind: "wait", reason: "profile null" };
  if (input.profileHydrated !== "network")
    return { kind: "wait", reason: `profileHydrated=${input.profileHydrated} (need network)` };
  if (input.disclaimerState !== "accepted")
    return { kind: "wait", reason: `disclaimerState=${input.disclaimerState}` };
  if (input.showSplash)
    return { kind: "wait", reason: "showSplash true" };

  const tier = input.profile.subscription_tier || null;
  const isPaid = isPaidTier(tier);
  const currentKey = computeKey(input.profile);

  // Keyed invalidation: se la key cambiata rispetto all'ultima decisione,
  // permetti nuova decisione (simulata a monte: il chiamante resetta il
  // ref hasRedirectedIntroV3 se la key cambia).
  const effectiveHasRedirected =
    input.lastV3DecidedKey !== null &&
    input.lastV3DecidedKey !== currentKey
      ? false
      : input.hasRedirectedIntroV3;

  if (effectiveHasRedirected)
    return { kind: "wait", reason: "already redirected (same key)" };

  if (isPaid) {
    return {
      kind: "mark_v3_completed",
      reason: `paid user (tier=${tier}) → skip V3 mark completed`,
      markKey: currentKey,
    };
  }

  return {
    kind: "redirect",
    target: "/intro-v3",
    reason: `free user (tier=${tier || "none"}) fresh install → V3`,
    markKey: currentKey,
  };
}

/**
 * Router Free/Premium — Free user → /lascia-andare, Paid → stay.
 *
 * Traduzione fedele di app/index.tsx righe ~1092-1150.
 * Include guard V3 completed + keyed invalidation module-level.
 */
function decideRouterFreePremium(input) {
  if (input.pathname !== "/")
    return { kind: "wait", reason: "not on / pathname" };
  if (!input.profile)
    return { kind: "wait", reason: "profile null" };
  if (input.profileHydrated !== "network")
    return { kind: "wait", reason: `profileHydrated=${input.profileHydrated} (need network)` };
  if (input.disclaimerState !== "accepted")
    return { kind: "wait", reason: `disclaimerState=${input.disclaimerState}` };
  if (input.showSplash)
    return { kind: "wait", reason: "showSplash true" };
  if (input.showColorIntro === true)
    return { kind: "wait", reason: "showColorIntro true" };
  if (input.introV3State !== "completed")
    return { kind: "wait", reason: `introV3State=${input.introV3State} (V3 has priority)` };

  const tier = input.profile.subscription_tier || null;
  const isPaid = isPaidTier(tier);
  const currentKey = computeKey(input.profile);

  // === FIX BUG CACHE TIER IN-SESSIONE (Fabio 2026-08-24) — Keyed invalidation
  // Se il tier è cambiato rispetto all'ultima decisione locale, il ref
  // `hasRedirectedFreeUser` si considera resettato → nuova decisione.
  // Il chiamante deve resettare il ref effettivo prima del prossimo run.
  const effectiveHasRedirected =
    input.lastFreePremiumLocalKey !== undefined &&
    input.lastFreePremiumLocalKey !== null &&
    input.lastFreePremiumLocalKey !== currentKey
      ? false
      : input.hasRedirectedFreeUser;

  if (effectiveHasRedirected)
    return { kind: "wait", reason: "already redirected (intra-mount, same key)" };

  // Guard module-level cross-mount con TIER: se la stessa key ha già
  // deciso, marca il ref locale e wait (non ridecide).
  if (currentKey !== null && input.lastFreePremiumDecidedKey === currentKey) {
    return { kind: "wait", reason: "same key already decided (module-level)" };
  }

  if (isPaid) {
    return {
      kind: "stay",
      reason: `paid user (tier=${tier}) → stay on Koda conversazionale`,
      markKey: currentKey,
    };
  }

  return {
    kind: "redirect",
    target: "/lascia-andare",
    reason: `free user (tier=${tier || "none"}) → landing lascia-andare`,
    markKey: currentKey,
  };
}

/**
 * Router Intro Premium — Premium senza intro-premium seen → /intro-premium.
 *
 * Traduzione fedele di app/index.tsx righe ~1180-1245.
 */
function decideRouterIntroPremium(input) {
  if (input.pathname !== "/")
    return { kind: "wait", reason: "not on / pathname" };
  if (input.introPremiumState !== "needed")
    return { kind: "wait", reason: `introPremiumState=${input.introPremiumState}` };
  if (!input.profile)
    return { kind: "wait", reason: "profile null" };
  if (input.profileHydrated !== "network")
    return { kind: "wait", reason: `profileHydrated=${input.profileHydrated} (need network)` };
  if (input.disclaimerState !== "accepted")
    return { kind: "wait", reason: `disclaimerState=${input.disclaimerState}` };
  if (input.showSplash)
    return { kind: "wait", reason: "showSplash true" };
  if (input.introV3State !== "completed")
    return { kind: "wait", reason: `introV3State=${input.introV3State} (V3 must be completed first)` };

  const tier = input.profile.subscription_tier || null;
  const isPaid = isPaidTier(tier);
  if (!isPaid)
    return { kind: "wait", reason: `not paid (tier=${tier || "none"})` };
  if (input.showColorIntro === true)
    return { kind: "wait", reason: "showColorIntro true" };

  const currentKey = computeKey(input.profile);
  const effectiveHasRedirected =
    input.lastIntroPremiumDecidedKey !== null &&
    input.lastIntroPremiumDecidedKey !== currentKey
      ? false
      : input.hasRedirectedIntroPremium;

  if (effectiveHasRedirected)
    return { kind: "wait", reason: "already redirected (same key)" };

  return {
    kind: "redirect",
    target: "/intro-premium",
    reason: "first paid boot with intro-premium=needed",
    markKey: currentKey,
  };
}

module.exports = {
  decideRouterV3,
  decideRouterFreePremium,
  decideRouterIntroPremium,
  isPaidTier,
  computeKey,
};
