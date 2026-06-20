/**
 * VAD Streaming Section — stub WEB
 * ──────────────────────────────────────────────────────────────────────
 * Versione web di lib/vad/streamingSection. Mostra solo un messaggio
 * informativo perché:
 *  1. @siteed/audio-studio è nativo-only e crasha sul bundle web
 *     ("Cannot read properties of undefined (reading 'install')")
 *  2. onnxruntime-react-native ha implementazione web limitata
 *
 * Metro risolve automaticamente questo file con suffisso .web.tsx
 * quando il target è web, mentre su iOS/Android prende il
 * `streamingSection.tsx` reale.
 */

import React from "react";
import { View, Text, StyleSheet } from "react-native";

export type StreamingSectionProps = {
  modelReady: boolean;
};

export function StreamingSection(_props: StreamingSectionProps) {
  return (
    <View style={styles.box}>
      <Text style={styles.title}>3. Streaming live (solo su mobile)</Text>
      <Text style={styles.note}>
        Questa sezione richiede @siteed/audio-studio e ONNX Runtime nativi.
        {"\n"}Apri Koda dal tuo iPhone (TestFlight) per testare lo streaming live.
      </Text>
    </View>
  );
}
const styles = StyleSheet.create({
  box: {
    backgroundColor: "rgba(255,255,255,0.04)",
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.06)",
  },
  title: { color: "#FFFFFF", fontSize: 15, fontWeight: "600", marginBottom: 12 },
  note: { color: "#7E8A9B", fontSize: 12, lineHeight: 17 },
});
