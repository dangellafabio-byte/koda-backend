/**
 * SafetyAlert — Overlay che appare quando /api/safety/check restituisce
 * risk_detected=true. Mostra:
 *   - Messaggio di Koda (advisory, presente/empatico)
 *   - Lista numeri ufficiali italiani con bottoni "Chiama"
 *   - Bottone "Continuiamo qui" per chiudere e tornare alla chat
 *
 * Tono: presenza, tenerezza, MAI clinico, MAI urgenza eccessiva.
 */
import React from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  Linking,
  Modal,
  ScrollView,
  Platform,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../lib/theme";
import type { SafetyCheckResult } from "../lib/api";

type Props = {
  visible: boolean;
  result: SafetyCheckResult | null;
  onClose: () => void;
};

export default function SafetyAlert({ visible, result, onClose }: Props) {
  const insets = useSafeAreaInsets();
  const { theme } = useTheme();

  if (!result || !result.risk_detected) return null;

  const amber = "#F59E0B"; // ambra calda — stato allerta

  const callNumber = (num: string) => {
    const cleaned = num.replace(/\s/g, "");
    const url = Platform.OS === "ios" ? `tel:${cleaned}` : `tel:${cleaned}`;
    Linking.openURL(url).catch(() => {});
  };

  return (
    <Modal
      visible={visible}
      animationType="fade"
      transparent={false}
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View style={[styles.root, { backgroundColor: theme.bg }]}>
        <ScrollView
          contentContainerStyle={{
            paddingTop: insets.top + 30,
            paddingBottom: insets.bottom + 30,
            paddingHorizontal: 24,
            flexGrow: 1,
            justifyContent: "center",
          }}
        >
          {/* Pulsing amber dot (visuale di presenza, non allarme) */}
          <View style={styles.dotWrap}>
            <View style={[styles.dot, { backgroundColor: amber }]} />
            <View style={[styles.dotHalo, { borderColor: amber + "66" }]} />
          </View>

          <Text style={[styles.heading, { color: theme.text }]}>Ti ascolto.</Text>

          {/* Messaggio di Koda */}
          {result.advisory_message ? (
            <Text style={[styles.advisory, { color: theme.text }]}>{result.advisory_message}</Text>
          ) : null}

          {/* Numeri */}
          {result.resources.length > 0 && (
            <View style={styles.resourcesBlock}>
              {result.resources.map((r, i) => (
                <Pressable
                  key={i}
                  onPress={() => callNumber(r.number)}
                  style={[styles.resourceBtn, { borderColor: amber + "66", backgroundColor: amber + "12" }]}
                  accessibilityRole="button"
                  accessibilityLabel={`Chiama ${r.label}, ${r.number}`}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.resourceLabel, { color: theme.text }]}>{r.label}</Text>
                    <Text style={[styles.resourceNumber, { color: amber }]}>{r.number}</Text>
                    {r.note ? (
                      <Text style={[styles.resourceNote, { color: theme.textDim }]}>{r.note}</Text>
                    ) : null}
                  </View>
                  <Text style={[styles.callIcon, { color: amber }]}>📞</Text>
                </Pressable>
              ))}
            </View>
          )}

          {/* CTA — torna alla chat */}
          <Pressable
            onPress={onClose}
            style={[styles.continueBtn, { borderColor: theme.border }]}
          >
            <Text style={[styles.continueText, { color: theme.text }]}>Continuiamo qui</Text>
          </Pressable>

          <Text style={[styles.footnote, { color: theme.textDim }]}>
            Non sostituisco un professionista. Sono solo presenza.
          </Text>
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  dotWrap: { alignItems: "center", marginBottom: 22, height: 60, justifyContent: "center" },
  dot: { width: 18, height: 18, borderRadius: 9 },
  dotHalo: { position: "absolute", width: 48, height: 48, borderRadius: 24, borderWidth: 2 },
  heading: { fontSize: 28, fontWeight: "600", textAlign: "center", marginBottom: 16 },
  advisory: { fontSize: 16, lineHeight: 24, textAlign: "center", marginBottom: 28, paddingHorizontal: 8 },
  resourcesBlock: { gap: 10, marginBottom: 28 },
  resourceBtn: { flexDirection: "row", alignItems: "center", padding: 14, borderRadius: 14, borderWidth: 1, minHeight: 64 },
  resourceLabel: { fontSize: 14, fontWeight: "600" },
  resourceNumber: { fontSize: 20, fontWeight: "700", letterSpacing: 0.5, marginTop: 2 },
  resourceNote: { fontSize: 12, marginTop: 4, lineHeight: 16 },
  callIcon: { fontSize: 24, marginLeft: 12 },
  continueBtn: { borderWidth: 1, borderRadius: 14, paddingVertical: 14, alignItems: "center", marginBottom: 14, minHeight: 48, justifyContent: "center" },
  continueText: { fontSize: 15, fontWeight: "500" },
  footnote: { fontSize: 11, textAlign: "center", lineHeight: 16, opacity: 0.7 },
});
