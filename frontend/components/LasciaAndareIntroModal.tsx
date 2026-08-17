/**
 * LasciaAndareIntroModal — Presentazione al PRIMO accesso.
 *
 * Design (Fabio 2026-08-14):
 *   L'utente tocca "Lascia andare" per la prima volta. Prima di aprire
 *   la stanza (che è un'esperienza visivamente radicale — schermo nero,
 *   orb solo), gli spieghiamo cosa sta per succedere. Solo la PRIMA
 *   volta. Il flag di persistenza è server-side (Mongo) → sopravvive
 *   a reinstall/cambio device.
 *
 *   Tono coerente con Koda: caldo, non didattico, non "clicca qui per
 *   info". Come se glielo dicesse un amico prima di lasciarti solo con
 *   te stesso.
 *
 * Uso:
 *   <LasciaAndareIntroModal
 *     visible={showIntro}
 *     onContinue={() => { markSeen(); navigate(); }}
 *     onCancel={() => setShowIntro(false)}
 *   />
 */
import React from "react";
import {
  View,
  Text,
  StyleSheet,
  Modal,
  TouchableOpacity,
  ScrollView,
  Platform,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../lib/theme";

type Props = {
  visible: boolean;
  onContinue: () => void;
  onCancel: () => void;
};

export default function LasciaAndareIntroModal({ visible, onContinue, onCancel }: Props) {
  const insets = useSafeAreaInsets();
  const { theme } = useTheme();

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onCancel}
      statusBarTranslucent
    >
      <View style={styles.backdrop}>
        <View
          style={[
            styles.card,
            {
              backgroundColor: theme.surface,
              borderColor: theme.border,
              marginTop: insets.top + 20,
              marginBottom: insets.bottom + 20,
            },
          ]}
        >
          <ScrollView
            contentContainerStyle={styles.scroll}
            showsVerticalScrollIndicator={false}
          >
            <Text style={[styles.title, { color: theme.text }]}>
              Lascia andare
            </Text>

            <Text style={[styles.paragraph, { color: theme.text }]}>
              È un posto dove nessuno risponde.
            </Text>

            <Text style={[styles.paragraph, { color: theme.textMuted }]}>
              Entri, lo schermo diventa nero, resta solo un piccolo
              respiro luminoso. Puoi dire quello che vuoi. Ad alta voce,
              anche urlato, anche a mezza voce. Ti sfoghi.
            </Text>

            <Text style={[styles.paragraph, { color: theme.textMuted }]}>
              Koda non ti risponde. Non ti ascolta nemmeno — nessuno
              ascolta. Non c&apos;è trascrizione, niente resta sul telefono,
              niente arriva a un server. Solo il piccolo respiro luminoso
              ti fa compagnia mentre parli.
            </Text>

            <Text style={[styles.paragraph, { color: theme.textMuted }]}>
              Quando esci, non c&apos;è traccia di niente. Nemmeno per te.
            </Text>

            <Text style={[styles.paragraphAccent, { color: theme.text }]}>
              Quando sei pronto.
            </Text>
          </ScrollView>

          <View style={styles.actions}>
            <TouchableOpacity
              onPress={onCancel}
              style={[styles.btnSecondary, { borderColor: theme.border }]}
              accessibilityRole="button"
              accessibilityLabel="Non ora"
              testID="lascia-andare-intro-cancel"
            >
              <Text style={[styles.btnSecondaryText, { color: theme.textMuted }]}>Non ora</Text>
            </TouchableOpacity>

            <TouchableOpacity
              onPress={onContinue}
              style={[styles.btnPrimary, { backgroundColor: theme.primary }]}
              accessibilityRole="button"
              accessibilityLabel="Entra"
              testID="lascia-andare-intro-continue"
            >
              <Text style={[styles.btnPrimaryText, { color: theme.primaryText }]}>Entra</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.75)",
    justifyContent: "center",
    paddingHorizontal: 20,
  },
  card: {
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    paddingTop: 28,
    paddingBottom: 20,
    paddingHorizontal: 22,
    maxHeight: "85%",
    ...Platform.select({
      ios: {
        shadowColor: "#000",
        shadowOffset: { width: 0, height: 8 },
        shadowOpacity: 0.35,
        shadowRadius: 20,
      },
      android: { elevation: 12 },
      default: {},
    }),
  },
  scroll: {
    paddingBottom: 12,
  },
  title: {
    fontSize: 24,
    fontWeight: "600",
    marginBottom: 20,
    textAlign: "center",
    letterSpacing: 0.2,
  },
  paragraph: {
    fontSize: 15.5,
    lineHeight: 23,
    marginBottom: 14,
    textAlign: "left",
  },
  paragraphAccent: {
    fontSize: 15.5,
    lineHeight: 23,
    marginTop: 8,
    marginBottom: 6,
    textAlign: "center",
    fontStyle: "italic",
  },
  actions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    alignItems: "center",
    gap: 12,
    marginTop: 16,
  },
  btnSecondary: {
    paddingVertical: 12,
    paddingHorizontal: 18,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
  },
  btnSecondaryText: {
    fontSize: 15,
    fontWeight: "500",
  },
  btnPrimary: {
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 12,
    minWidth: 100,
    alignItems: "center",
  },
  btnPrimaryText: {
    fontSize: 15,
    fontWeight: "600",
  },
});
