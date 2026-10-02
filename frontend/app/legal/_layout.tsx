/**
 * app/legal/_layout.tsx — v67.7 (Fabio 2026-06-24, doc unico sezione 3)
 *
 * Stack layout per /legal/terms e /legal/privacy.
 * X close button ESPLICITO in headerRight (sempre visibile, anche dopo scroll).
 * Pop torna alla schermata precedente, non alla Home.
 */
import React from "react";
import { Stack, useRouter } from "expo-router";
import { TouchableOpacity } from "react-native";
import { Ionicons } from "@expo/vector-icons";

function HeaderCloseButton() {
  const router = useRouter();
  return (
    <TouchableOpacity
      onPress={() => {
        // Pop se possibile (torna alla schermata precedente),
        // altrimenti back al root dello stack chiamante.
        try {
          if (router.canGoBack()) router.back();
          else router.replace("/");
        } catch {
          try { router.back(); } catch {}
        }
      }}
      hitSlop={{ top: 12, bottom: 12, left: 12, right: 16 }}
      accessibilityLabel="Chiudi"
      testID="legal-close-btn"
      style={{ paddingHorizontal: 12, paddingVertical: 6 }}
    >
      <Ionicons name="close" size={28} color="#F5E6CC" />
    </TouchableOpacity>
  );
}

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
        headerRight: () => <HeaderCloseButton />,
      }}
    >
      <Stack.Screen name="terms" options={{ title: "Termini di Servizio" }} />
      <Stack.Screen name="privacy" options={{ title: "Privacy Policy" }} />
    </Stack>
  );
}
