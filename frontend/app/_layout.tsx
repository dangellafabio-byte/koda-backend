import React, { useEffect, useState, useRef } from "react";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { View, StyleSheet, Platform, AppState, AppStateStatus } from "react-native";
// === BLOCCO A (2026-08-25) — `lib/notifications` RIMOSSO ==================
// Koda non manda più notifiche schedulate né settimanali. Il modulo stub è
// stato eliminato per rendere esplicito nel codice l'impegno "no needy Koda".
// Se serve reintrodurre notifiche in futuro, ripristinare da git v64.x.
import { ThemeProvider, useTheme, ThemeName } from "../lib/theme";
import { api } from "../lib/api";
import { prewarmAudio } from "../lib/speech";
import { loadProfileCache } from "../lib/localCache";
import { AuthProvider, useAuth } from "../lib/auth";
import LoginScreen from "../components/LoginScreen";
import TrialWatcher from "../components/TrialWatcher";
import OfflineOverlay from "../components/OfflineOverlay";
import { installDiagLogger } from "../lib/diagLogger";
// === PIANO B FIX 2026-07-19 — static import (era lazy require) ===
import { KODA_BACKEND_URL } from "../lib/backendUrl";
// === DIAG LOGGER (sprint v12) ===
// Install all'import del modulo (eseguito UNA volta al boot, prima
// che qualsiasi altro modulo possa emettere console.log KODA_*).
// È idempotente quindi anche un eventuale doppio import è safe.
installDiagLogger();

// ============================================================
// BACKEND KEEP-ALIVE 2026-06
// ============================================================
// PROBLEMA: il container preview di Emergent va in sleep dopo
// ~5 min di inattività. La prima richiesta dopo lo sleep impiega
// 60-90 secondi a tornare → l'app sembra "bloccata".
// FIX: ping leggero ogni 4 min al backend mentre l'app è in
// foreground (background lo skip-piamo per non sprecare batteria).
// ============================================================
const KEEP_ALIVE_INTERVAL_MS = 4 * 60 * 1000; // 4 minuti
const KEEP_ALIVE_TIMEOUT_MS = 8000; // 8 sec timeout per il ping (best-effort)

async function pingBackend(): Promise<void> {
  try {
    // === PIANO B FIX 2026-07-19 — static import invece di lazy require ===
    const base = (KODA_BACKEND_URL || "").replace(/\/$/, "");
    if (!base) return;
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), KEEP_ALIVE_TIMEOUT_MS);
    try {
      await fetch(`${base}/api/profile`, {
        method: "GET",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(t);
    }
  } catch {
    // Silent. È solo "warm-up", non importa se fallisce.
  }
}

function ThemedShell({ children }: { children: React.ReactNode }) {
  const { theme } = useTheme();
  return (
    <>
      <StatusBar style={theme.isDark ? "light" : "dark"} />
      <View style={[styles.root, { backgroundColor: theme.bg }]}>{children}</View>
    </>
  );
}

function AuthGate({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) {
    return <View style={[styles.root, { backgroundColor: "#000000" }]} />;
  }
  if (!user) {
    return <LoginScreen />;
  }
  return <>{children}</>;
}

function RootLayout() {
  // === DARK MODE DEFAULT AL PRIMO AVVIO (richiesta utente 2026-07) ===
  // Prima usavamo "sistema" (segue iOS): se il telefono era in light mode
  // l'utente vedeva l'app in chiaro al primo boot, spesso sgradevole per
  // un'esperienza notturna/emotiva come Koda. Ora forziamo NOTTE come
  // default finché l'utente non sceglie esplicitamente un altro tema
  // dalle Impostazioni. Se profile.settings.theme è già settato in cache
  // o su server, viene rispettato.
  const [initialTheme, setInitialTheme] = useState<ThemeName>("notte");
  const [dayStart, setDayStart] = useState(7);
  const [nightStart, setNightStart] = useState(20);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    // === FIX 2026-07: RIMOSSO BLOCCO OTA AUTO-RELOAD ===
    // Il vecchio codice qui faceva checkForUpdateAsync() → fetchUpdateAsync()
    // → reloadAsync() al cold start. Era pensato per "forzare gli update",
    // ma in pratica:
    //   - checkForUpdateAsync() NON ha timeout → su rete lenta/DNS pigro
    //     blocca per minuti
    //   - reloadAsync() riavvia l'app → l'utente vede di nuovo l'indaco
    //   - Risultato: 5-20 minuti di "limbo" ogni cold start
    //
    // Soluzione definitiva: lasciamo che expo-updates faccia il suo lavoro
    // SILENZIOSAMENTE in background (è il comportamento di default, già
    // configurato in app.json). L'eventuale OTA verrà applicato al PROSSIMO
    // avvio dell'app, senza reload visibile, senza loop.
    // Per garantire che la build appena installata non riceva mai più
    // OTA vecchi: abbiamo bumped expo.version → nuovo runtimeVersion.

    // Pre-warm iOS/Android audio session BEFORE first TTS plays.
    // Fixes "Koda silent in first intro steps" bug on fresh native build.
    prewarmAudio().catch(() => {});

    if (Platform.OS !== "web") {
      // === BLOCCO A (2026-08-25) — scheduleWeeklyAppNotification RIMOSSO ==
      // Nessun promemoria settimanale automatico.
    }
    (async () => {
      // === FAST-PATH CACHE (2026-06) ===
      // Prima del network, leggi la cache locale e applica TEMA / orari.
      // Così l'utente al cold start salta direttamente alla home senza
      // vedere lo schermo nero di "loading" se la rete è lenta.
      try {
        const cached = await loadProfileCache<any>();
        if (cached) {
          const t = (cached.settings?.theme as ThemeName) || "notte";
          setInitialTheme(t);
          if (typeof cached.settings?.day_start_hour === "number") setDayStart(cached.settings.day_start_hour);
          if (typeof cached.settings?.night_start_hour === "number") setNightStart(cached.settings.night_start_hour);
          // Abbiamo dati locali: sblocchiamo SUBITO l'UI. Il network
          // continuerà in parallelo per gli aggiornamenti.
          setReady(true);
        }
      } catch {
        // ignore
      }

      // === FIX 2026-06-28 SERA: timeout + retry sulla fetch profilo ===
      // PROBLEMA: in passato facevamo `await api.getProfile()` senza
      // timeout. iOS al cold start ha la rete/DNS spesso non pronti
      // → la fetch poteva restare appesa per MINUTI → l'app restava
      // nello stato `!ready` che mostra una View vuota con
      // backgroundColor #0B0F1A (indaco scuro). L'utente vedeva una
      // "versione base, app non utilizzabile" per 5-10 minuti.
      //
      // SOLUZIONE 2026-07: timeout AGGRESSIVO a 2.5s. Se in 2.5s
      // la fetch non risponde, procediamo SUBITO con i default.
      // index.tsx ha un retry-on-AppState-change che caricherà il
      // profilo appena la rete è pronta. L'importante è far vedere
      // l'app il prima possibile.
      const PROFILE_TIMEOUT_MS = 2500;
      try {
        const p = await Promise.race([
          api.getProfile(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("profile-cold-timeout")), PROFILE_TIMEOUT_MS)
          ),
        ]);
        const t = (p.settings?.theme as ThemeName) || "notte";
        setInitialTheme(t);
        if (typeof p.settings?.day_start_hour === "number") setDayStart(p.settings.day_start_hour);
        if (typeof p.settings?.night_start_hour === "number") setNightStart(p.settings.night_start_hour);
      } catch {
        // Rete lenta / DNS non pronto / preview down: NON bloccare l'UI.
        // index.tsx farà i suoi tentativi di caricamento.
      }
      setReady(true); // SEMPRE procediamo. Mai più "limbo indaco".
    })();

    // ====================================================
    // KEEP-ALIVE 2026-06: ping ogni 4 min finché in foreground.
    // Tiene caldo il container backend di Emergent (che altrimenti
    // va in sleep dopo ~5 min di inattività → prossima richiesta
    // dell'utente sembra "bloccata" per 60-90 sec).
    // ====================================================
    let keepAliveTimer: ReturnType<typeof setInterval> | null = null;
    let currentAppState: AppStateStatus = AppState.currentState;

    const startKeepAlive = () => {
      if (keepAliveTimer) return;
      // ping immediato (l'utente sta usando l'app ADESSO)
      pingBackend();
      keepAliveTimer = setInterval(() => {
        pingBackend();
      }, KEEP_ALIVE_INTERVAL_MS);
    };

    const stopKeepAlive = () => {
      if (keepAliveTimer) {
        clearInterval(keepAliveTimer);
        keepAliveTimer = null;
      }
    };

    if (currentAppState === "active") startKeepAlive();

    const sub = AppState.addEventListener("change", (next) => {
      const wasBackground = currentAppState !== "active";
      currentAppState = next;
      if (next === "active") {
        // Tornato in foreground: ping subito (potrebbe essere passato
        // tanto tempo dall'ultimo ping → backend probabilmente cold)
        if (wasBackground) pingBackend();
        startKeepAlive();
      } else {
        stopKeepAlive();
      }
    });

    return () => {
      stopKeepAlive();
      sub.remove();
    };
  }, []);

  if (!ready) {
    // Avoid theme flash: render minimal black screen until profile arrives.
    // Background nero pieno (NON indaco) così l'utente non vede mai più
    // "indaco vuoto" come fosse un bug.
    return (
      <SafeAreaProvider>
        <View style={[styles.root, { backgroundColor: "#000000" }]} />
      </SafeAreaProvider>
    );
  }

  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        <AuthProvider>
          <ThemeProvider
            initialName={initialTheme}
            initialDayStart={dayStart}
            initialNightStart={nightStart}
          >
            <ThemedShell>
              <AuthGate>
                <TrialWatcher>
                  <Stack
                    screenOptions={{
                      headerShown: false,
                      contentStyle: { backgroundColor: "transparent" },
                      animation: "fade",
                    }}
                  />
                </TrialWatcher>
              </AuthGate>
              {/* Overlay offline globale — sopra qualsiasi screen ma
                  pointer-events="none" quindi non blocca nulla.
                  Fabio 2026-08-14: P1 offline UX. */}
              <OfflineOverlay />
            </ThemedShell>
          </ThemeProvider>
        </AuthProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});

export default RootLayout;
