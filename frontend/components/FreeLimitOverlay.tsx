/**
 * FreeLimitOverlay v65.53 (Fabio 2026-06)
 * =======================================
 * Overlay elegante che compare quando l'utente Free esaurisce i 5 turni
 * del periodo. Testo:
 *   "Per questo periodo ci fermiamo qui, {nome}. Torno a scriverti {countdown}."
 *   "Se vuoi continuare subito, c'è il Premium — sennò ti aspetto qui,
 *    senza fretta."
 *
 * Il countdown è LIVE: si aggiorna automaticamente tramite
 * useLiveCountdown(periodEndsAtIso), quindi resta accurato anche se l'utente
 * lascia l'overlay aperto per ore.
 *
 * Due CTA:
 *   - "Passa al Premium" → naviga a /paywall
 *   - "Va bene, aspetto" → chiude l'overlay
 *
 * Tono coerente con Ollenya: mai aggressivo, mai urgente, mai da paywall
 * classico. Nessuna scadenza artificiale.
 */
import React, { useEffect } from "react";
import { Modal, View, Text, TouchableOpacity, StyleSheet, Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useLiveCountdown } from "../lib/freeCountdown";

type Props = {
  visible: boolean;
  greeting: string; // "Per questo periodo ci fermiamo qui, Marco."
  countdown: string; // fallback statico se periodEndsAtIso è null
  periodEndsAtIso: string | null;
  onDismiss: () => void;
  onGoPremium: () => void;
};

export default function FreeLimitOverlay({
  visible,
  greeting,
  countdown,
  periodEndsAtIso,
  onDismiss,
  onGoPremium,
}: Props) {
  const insets = useSafeAreaInsets();
  const liveCountdown = useLiveCountdown(periodEndsAtIso);
  const displayCountdown = liveCountdown || countdown || "tra poco";

  useEffect(() => {
    if (visible) {
      console.log(`[free_overlay] shown countdown="${displayCountdown}"`);
    }
  }, [visible, displayCountdown]);

  if (!visible) return null;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={onDismiss}
    >
      <View style={[styles.backdrop, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        <View style={styles.card}>
          <View style={styles.iconWrap}>
            <Ionicons name="time-outline" size={26} color="#F5E6CC" />
          </View>

          <Text style={styles.headline}>{greeting}</Text>
          <Text style={styles.countdown}>Torno a scriverti {displayCountdown}.</Text>

          <Text style={styles.bodyText}>
            Se vuoi continuare subito, c&apos;è il Premium — sennò ti aspetto qui,
            senza fretta.
          </Text>

          <TouchableOpacity onPress={onGoPremium} style={styles.primaryBtn} testID="free-overlay-premium">
            <Text style={styles.primaryText}>Passa al Premium</Text>
          </TouchableOpacity>

          <TouchableOpacity onPress={onDismiss} style={styles.secondaryBtn} testID="free-overlay-dismiss">
            <Text style={styles.secondaryText}>Va bene, aspetto</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(15, 15, 26, 0.78)",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
  },
  card: {
    width: "100%",
    maxWidth: 360,
    borderRadius: 20,
    backgroundColor: "rgba(31, 26, 54, 0.98)",
    borderWidth: 1,
    borderColor: "rgba(212, 184, 150, 0.18)",
    paddingVertical: 24,
    paddingHorizontal: 22,
    alignItems: "center",
    ...Platform.select({
      ios: {
        shadowColor: "#000",
        shadowOffset: { width: 0, height: 10 },
        shadowOpacity: 0.28,
        shadowRadius: 24,
      },
      android: {
        elevation: 10,
      },
    }),
  },
  iconWrap: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: "rgba(212, 184, 150, 0.12)",
    borderWidth: 1,
    borderColor: "rgba(212, 184, 150, 0.24)",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 14,
  },
  headline: {
    color: "#F5E6CC",
    fontSize: 17,
    fontWeight: "600",
    textAlign: "center",
    lineHeight: 23,
    marginBottom: 4,
  },
  countdown: {
    color: "rgba(226, 232, 240, 0.92)",
    fontSize: 15,
    textAlign: "center",
    lineHeight: 22,
    marginBottom: 14,
  },
  bodyText: {
    color: "rgba(226, 232, 240, 0.72)",
    fontSize: 14,
    lineHeight: 21,
    textAlign: "center",
    marginBottom: 20,
  },
  primaryBtn: {
    width: "100%",
    paddingVertical: 13,
    borderRadius: 12,
    backgroundColor: "#D4B896",
    alignItems: "center",
    marginBottom: 10,
  },
  primaryText: {
    color: "#1F1A36",
    fontSize: 15,
    fontWeight: "700",
    letterSpacing: 0.2,
  },
  secondaryBtn: {
    width: "100%",
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: "center",
  },
  secondaryText: {
    color: "rgba(226, 232, 240, 0.72)",
    fontSize: 14,
    fontWeight: "500",
  },
});
