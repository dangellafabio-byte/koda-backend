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
      try {
        const p = await api.getProfile();
        const t = (p.settings?.theme as ThemeName) || "sistema";
        setInitialTheme(t);
        if (typeof p.settings?.day_start_hour === "number") setDayStart(p.settings.day_start_hour);
        if (typeof p.settings?.night_start_hour === "number") setNightStart(p.settings.night_start_hour);
      } catch {}
      setReady(true);
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
