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
