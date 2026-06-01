import React, { useEffect, useState } from "react";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { View, StyleSheet, Platform } from "react-native";
import { scheduleWeeklyAppNotification } from "../lib/notifications";
import { ThemeProvider, useTheme, ThemeName } from "../lib/theme";
import { api } from "../lib/api";
import { prewarmAudio } from "../lib/speech";
import { loadProfileCache } from "../lib/localCache";

function ThemedShell({ children }: { children: React.ReactNode }) {
  const { theme } = useTheme();
  return (
    <>
      <StatusBar style={theme.isDark ? "light" : "dark"} />
      <View style={[styles.root, { backgroundColor: theme.bg }]}>{children}</View>
    </>
  );
}

export default function RootLayout() {
  const [initialTheme, setInitialTheme] = useState<ThemeName>("sistema");
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
      setTimeout(() => {
        scheduleWeeklyAppNotification().catch(() => {});
      }, 1500);
      // not blocking init
    }
    (async () => {
      // === FAST-PATH CACHE (2026-06) ===
      // Prima del network, leggi la cache locale e applica TEMA / orari.
      // Così l'utente al cold start salta direttamente alla home senza
      // vedere lo schermo nero di "loading" se la rete è lenta.
      try {
        const cached = await loadProfileCache<any>();
        if (cached) {
          const t = (cached.settings?.theme as ThemeName) || "sistema";
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
        const t = (p.settings?.theme as ThemeName) || "sistema";
        setInitialTheme(t);
        if (typeof p.settings?.day_start_hour === "number") setDayStart(p.settings.day_start_hour);
        if (typeof p.settings?.night_start_hour === "number") setNightStart(p.settings.night_start_hour);
      } catch {
        // Rete lenta / DNS non pronto / preview down: NON bloccare l'UI.
        // index.tsx farà i suoi tentativi di caricamento.
      }
      setReady(true); // SEMPRE procediamo. Mai più "limbo indaco".
    })();
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
        <ThemeProvider
          initialName={initialTheme}
          initialDayStart={dayStart}
          initialNightStart={nightStart}
        >
          <ThemedShell>
            <Stack
              screenOptions={{
                headerShown: false,
                contentStyle: { backgroundColor: "transparent" },
                animation: "fade",
              }}
            />
          </ThemedShell>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});
