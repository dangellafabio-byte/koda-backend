import React, { useEffect, useState } from "react";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { View, StyleSheet, Platform } from "react-native";
import * as Updates from "expo-updates";
import { scheduleWeeklyAppNotification } from "../lib/notifications";
import { ThemeProvider, useTheme, ThemeName } from "../lib/theme";
import { api } from "../lib/api";
import { prewarmAudio } from "../lib/speech";

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
    // === FIX 2026-06-28: AUTO-APPLY OTA UPDATES ON COLD START ===
    // Senza questo, expo-updates scarica il bundle in background ma lo
    // applica solo al PROSSIMO avvio dell'app. Risultato: ogni volta che
    // l'utente apre l'app dopo molta inattività, gira il bundle vecchio
    // (embed nel binario o quello applicato prima) per ~5 minuti finché
    // il sistema non scarica e ricarica.
    // Con questo blocco: al cold start controlliamo se c'è un update;
    // se sì, scarichiamo e ricarichiamo IMMEDIATAMENTE.
    // Side effects: ~500ms-2s di "splash" in più all'avvio se c'è
    // davvero un update. Senza update: nessun impatto (la check è
    // rapida quando non c'è niente da scaricare).
    (async () => {
      try {
        if (!__DEV__ && Updates.isEnabled) {
          const u = await Updates.checkForUpdateAsync();
          if (u.isAvailable) {
            await Updates.fetchUpdateAsync();
            // Ricarica subito: l'utente vede 1-2s di splash ma poi
            // è sull'ultima versione. Niente più "5 minuti rotti".
            await Updates.reloadAsync();
            return; // mai raggiunto: reloadAsync() resetta tutto
          }
        }
      } catch {
        // Update check fallita (offline, server EAS down, ecc.):
        // ignora silenziosamente, l'app parte con il bundle corrente.
      }
    })();

    // Pre-warm iOS/Android audio session BEFORE first TTS plays.
    // Fixes "Koda silent in first intro steps" bug on fresh native build.
    prewarmAudio().catch(() => {});

    if (Platform.OS !== "web") {
      const t = setTimeout(() => {
        scheduleWeeklyAppNotification().catch(() => {});
      }, 1500);
      // not blocking init
    }
    (async () => {
      // === FIX 2026-06-28 SERA: timeout + retry sulla fetch profilo ===
      // PROBLEMA: in passato facevamo `await api.getProfile()` senza
      // timeout. iOS al cold start ha la rete/DNS spesso non pronti
      // → la fetch poteva restare appesa per MINUTI → l'app restava
      // nello stato `!ready` che mostra una View vuota con
      // backgroundColor #0B0F1A (indaco scuro). L'utente vedeva una
      // "versione base, app non utilizzabile" per 5-10 minuti.
      //
      // SOLUZIONE: race con un timeout di 5s. Se in 5s la fetch non
      // ha risposto, procediamo con i default e lasciamo che index.tsx
      // (che ha il suo retry su AppState change) carichi il profilo
      // appena la rete è pronta. L'importante è che l'app sia
      // VISIBILE e USABILE, non bloccata in limbo.
      const PROFILE_TIMEOUT_MS = 5000;
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
    // Avoid theme flash: render minimal black screen until profile arrives
    return (
      <SafeAreaProvider>
        <View style={[styles.root, { backgroundColor: "#0B0F1A" }]} />
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
