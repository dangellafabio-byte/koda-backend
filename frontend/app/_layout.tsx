import React, { useEffect, useState } from "react";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { View, StyleSheet, Platform } from "react-native";
import * as SplashScreen from "expo-splash-screen";
import { scheduleWeeklyAppNotification } from "../lib/notifications";
import { ThemeProvider, useTheme, ThemeName } from "../lib/theme";
import { api } from "../lib/api";

// Trattiene lo splash screen finché l'app non è davvero pronta (profile
// caricato, theme inizializzato). SENZA QUESTO, lo splash NERO resta
// visibile in eterno e l'utente vede solo "schermo nero".
SplashScreen.preventAutoHideAsync().catch(() => {});

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
    if (Platform.OS !== "web") {
      const t = setTimeout(() => {
        scheduleWeeklyAppNotification().catch(() => {});
      }, 1500);
      // not blocking init
    }
    // Safety net: dopo 5s nascondi comunque lo splash, anche se profile/theme
    // sono lentissimi. Non vogliamo MAI lasciare l'utente con schermo nero.
    const splashSafety = setTimeout(() => {
      SplashScreen.hideAsync().catch(() => {});
    }, 5000);
    (async () => {
      try {
        const p = await api.getProfile();
        const t = (p.settings?.theme as ThemeName) || "sistema";
        setInitialTheme(t);
        if (typeof p.settings?.day_start_hour === "number") setDayStart(p.settings.day_start_hour);
        if (typeof p.settings?.night_start_hour === "number") setNightStart(p.settings.night_start_hour);
      } catch {}
      setReady(true);
      // Nascondi lo splash screen NERO una volta che il theme è inizializzato.
      // SENZA QUESTO, l'utente vede schermo nero per sempre.
      SplashScreen.hideAsync().catch(() => {});
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
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});
