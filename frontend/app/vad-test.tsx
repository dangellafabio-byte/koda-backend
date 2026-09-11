/**
 * /vad-test — DISABILITATO (2026-09-11)
 * ======================================
 *
 * Pagina test VAD locale via @siteed/audio-studio: sospesa. La libreria
 * era incompatibile con Expo SDK 54 (errore Kotlin `reject overrides
 * nothing`) e ha bloccato per giorni il build EAS Android. Rimossa da
 * package.json + app.json → hook `useLocalVadRecorder` ora è uno stub.
 *
 * Vedi `lib/useLocalVadRecorder.ts` per storia e piano di ripristino.
 * Fabio, riabilitare solo se serve calibrare la soglia RMS su hardware
 * MIUI: prima verificare che la libreria abbia risolto il conflitto.
 */

import React from "react";
import { View, Text, StyleSheet, TouchableOpacity } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";

export default function VadTestScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();

  return (
    <View style={[styles.wrap, { paddingTop: insets.top + 16 }]}>
      <TouchableOpacity
        style={styles.backBtn}
        onPress={() => router.back()}
        accessibilityRole="button"
      >
        <Text style={styles.backText}>← Indietro</Text>
      </TouchableOpacity>

      <Text style={styles.title}>VAD Test — Non disponibile</Text>
      <Text style={styles.body}>
        La libreria PCM raw usata da questa schermata (@siteed/audio-studio)
        è temporaneamente incompatibile con la versione corrente di Expo.
        {"\n\n"}
        Il flusso vocale in produzione non è impattato: usa endpointing
        server-side via Deepgram, che aggira il problema di metering su
        Android MIUI.
        {"\n\n"}
        Pagina riabilitata quando la libreria pubblica una versione allineata.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    backgroundColor: "#0a0a0a",
    paddingHorizontal: 20,
  },
  backBtn: {
    alignSelf: "flex-start",
    paddingVertical: 8,
    paddingHorizontal: 4,
    marginBottom: 12,
  },
  backText: {
    color: "#a3a3a3",
    fontSize: 15,
  },
  title: {
    color: "#ffffff",
    fontSize: 22,
    fontWeight: "600",
    marginBottom: 12,
  },
  body: {
    color: "#a3a3a3",
    fontSize: 14,
    lineHeight: 22,
  },
});
