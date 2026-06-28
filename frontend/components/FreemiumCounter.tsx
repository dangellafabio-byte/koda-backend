/**
 * FreemiumCounter — Etichetta minimale che mostra i messaggi gratis rimasti.
 * Compare solo se l'utente non è abbonato e ha consumato 0-2 messaggi.
 * Tono "onesto", non aggressivo. Si dissolve a 0 (al 4° tap il paywall scatta).
 */
import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { useTheme } from "../lib/theme";

type Props = {
  remaining: number;
  total: number;
  visible: boolean;
};

export default function FreemiumCounter({ remaining, total, visible }: Props) {
  const { theme } = useTheme();
  if (!visible) return null;

  const label =
    remaining === 0
      ? "Stai per concludere la prova"
      : remaining === 1
      ? "1 messaggio di prova rimanente"
      : `${remaining} messaggi di prova rimanenti`;

  return (
    <View style={styles.wrap} pointerEvents="none">
      <View style={[styles.pill, { backgroundColor: theme.surface + "EE", borderColor: theme.border }]}>
        {/* === FIX 2026-06-28 v30 — testo SEMPRE bianco/contrastato ===
            Prima: theme.textDim = rgba(255,255,255,0.55) sul tema Chiaro
            su bg theme.surface + "AA" → contrasto bassissimo, leggibile
            come "scuro/nero" su Home grigia. Ora text full (theme.text)
            + bg più opaco (EE invece di AA) per netto stacco. */}
        <Text style={[styles.text, { color: theme.text }]}>{label}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: "center", paddingVertical: 6 },
  pill: { paddingHorizontal: 12, paddingVertical: 4, borderRadius: 12, borderWidth: 1 },
  text: { fontSize: 11, fontWeight: "500", letterSpacing: 0.2 },
});
