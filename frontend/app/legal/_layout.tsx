/**
 * app/legal/_layout.tsx — v67.4 (Fabio 2026-06-24)
 * Stack layout per le pagine legali (/legal/terms, /legal/privacy).
 * Header nativo con back button, sfondo coerente col tema notturno.
 */
import React from "react";
import { Stack } from "expo-router";

export default function LegalLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: true,
        headerStyle: { backgroundColor: "#0F0C1C" },
        headerTintColor: "#F5E6CC",
        headerTitleStyle: { color: "#F5E6CC", fontSize: 17, fontWeight: "600" },
        headerBackTitle: "Indietro",
        contentStyle: { backgroundColor: "#0F0C1C" },
      }}
    >
      <Stack.Screen name="terms" options={{ title: "Termini di Servizio" }} />
      <Stack.Screen name="privacy" options={{ title: "Privacy Policy" }} />
    </Stack>
  );
}
