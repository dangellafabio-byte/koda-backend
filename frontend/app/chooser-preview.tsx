// app/chooser-preview.tsx
// Route temporanea SOLO per anteprima del nuovo HomeChooser.
// Non integrata nel flusso reale — verrà rimossa dopo l'approvazione utente.
// Accedibile via /chooser-preview
import React from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import HomeChooser from "../components/HomeChooser";
import { useTheme } from "../lib/theme";

export default function ChooserPreview() {
  const { theme } = useTheme();
  const [variant, setVariant] = React.useState<"premium" | "free_full" | "free_partial" | "free_exhausted">("free_full");
  const [lastAction, setLastAction] = React.useState<string>("");

  const freeStatus = variant === "premium"
    ? null
    : variant === "free_full"
    ? { remaining: 5, limit: 5, countdown_it: "tra 3 giorni" }
    : variant === "free_partial"
    ? { remaining: 2, limit: 5, countdown_it: "tra 3 giorni" }
    : { remaining: 0, limit: 5, countdown_it: "tra 2g 14h" };

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <HomeChooser
        isPaid={variant === "premium"}
        freeStatus={freeStatus}
        onPickOllenya={() => setLastAction("→ Parla con Ollenya")}
        onPickLasciaAndare={() => setLastAction("→ Lascia andare")}
      />
      {/* Overlay dev-only: switch tra le varianti */}
      <View style={[styles.devBar, { backgroundColor: theme.surfaceAlt, borderColor: theme.border }]}>
        <Text style={[styles.devLabel, { color: theme.textDim }]}>preview: {variant}</Text>
        <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
          {(["free_full", "free_partial", "free_exhausted", "premium"] as const).map((v) => (
            <TouchableOpacity
              key={v}
              onPress={() => setVariant(v)}
              style={[
                styles.devBtn,
                {
                  backgroundColor: v === variant ? theme.primary : "transparent",
                  borderColor: theme.border,
                },
              ]}
            >
              <Text style={{ color: v === variant ? theme.primaryText : theme.textMuted, fontSize: 11 }}>
                {v.replace("_", " ")}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
        {lastAction ? <Text style={[styles.devLabel, { color: theme.text, marginTop: 4 }]}>{lastAction}</Text> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  devBar: {
    position: "absolute",
    bottom: 40,
    left: 12,
    right: 12,
    padding: 10,
    borderRadius: 12,
    borderWidth: 1,
    gap: 6,
  },
  devLabel: { fontSize: 10, fontWeight: "500", letterSpacing: 0.3 },
  devBtn: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: 1,
  },
});
