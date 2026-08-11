/**
 * TrialExpiredOverlay — Full-screen modale mostrata quando il trial è
 * expired (budget 7 min esaurito o finestra 5 giorni scaduta).
 *
 * Design principles (spec Fabio 2026-08-10):
 *   - Compare SOLO dopo che l'ultimo TTS di Koda è finito (didJustFinish
 *     del player). Il TrialWatcher gestisce questo timing via polling —
 *     il primo poll che rileva "expired" arriva dopo la generazione TTS,
 *     quindi il turno di congedo è già completato acusticamente.
 *   - Testo relazionale, NON tecnico. Nessun conteggio, nessuna cifra,
 *     nessuna scadenza esatta. "Il primo incontro è terminato" è la
 *     formula concordata.
 *   - Un solo CTA verso /paywall. Nessun bottone chiudi/dismiss:
 *     l'overlay è bloccante per design (l'utente ha finito il trial,
 *     deve scegliere se continuare o meno).
 *   - Palette allineata al tema corrente. Fade-in morbido (400ms) per
 *     coerenza con il "gesto di garbo" della chiusura.
 */
import React, { useEffect, useRef } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  Animated,
  Modal,
  Platform,
} from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../lib/theme";

const TAG = "KODA_TRIAL_OVERLAY";

type Props = {
  visible: boolean;
  onDismiss?: () => void;  // opzionale, chiamato quando l'utente naviga a paywall
};

export default function TrialExpiredOverlay({ visible, onDismiss }: Props) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();

  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) {
      console.log(`[${TAG}] mostrato — trial expired`);
      Animated.timing(opacity, {
        toValue: 1,
        duration: 400,
        useNativeDriver: true,
      }).start();
    } else {
      opacity.setValue(0);
    }
  }, [visible, opacity]);

  const handleSeeParams = () => {
    console.log(`[${TAG}] CTA "Vedi i piani" premuto — navigate to /paywall`);
    try {
      router.push("/paywall");
    } catch (e) {
      console.warn(`[${TAG}] navigation to /paywall failed:`, e);
    }
    onDismiss?.();
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none" // gestiamo noi il fade via Animated
      onRequestClose={() => {
        // Sui Android il back button non deve chiudere l'overlay.
        // È bloccante per design.
      }}
      statusBarTranslucent
    >
      <Animated.View
        style={[
          styles.backdrop,
          {
            opacity,
            backgroundColor: theme.isDark
              ? "rgba(0, 0, 0, 0.88)"
              : "rgba(20, 20, 30, 0.88)",
            paddingTop: insets.top + 24,
            paddingBottom: insets.bottom + 24,
          },
        ]}
      >
        <View
          style={[
            styles.card,
            {
              backgroundColor: theme.surface ?? (theme.isDark ? "#101014" : "#FAFAFA"),
              borderColor: theme.isDark
                ? "rgba(255,255,255,0.08)"
                : "rgba(0,0,0,0.06)",
            },
          ]}
        >
          <Text
            style={[
              styles.title,
              { color: theme.text ?? (theme.isDark ? "#F2F2F5" : "#0A0A0F") },
            ]}
          >
            Il primo incontro è terminato.
          </Text>

          <Text
            style={[
              styles.body,
              {
                color: theme.textMuted ?? (theme.isDark
                  ? "rgba(255,255,255,0.66)"
                  : "rgba(0,0,0,0.62)"),
              },
            ]}
          >
            Se vuoi continuare a parlare con Koda, puoi scegliere un piano.
          </Text>

          <Pressable
            onPress={handleSeeParams}
            style={({ pressed }) => [
              styles.cta,
              {
                backgroundColor: theme.primary ?? "#7C6BFF",
                opacity: pressed ? 0.82 : 1.0,
              },
            ]}
            accessibilityRole="button"
            accessibilityLabel="Vedi i piani per continuare con Koda"
          >
            <Text
              style={[
                styles.ctaText,
                { color: theme.primaryText ?? "#FFFFFF" },
              ]}
            >
              Vedi i piani
            </Text>
          </Pressable>
        </View>
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 24,
  },
  card: {
    width: "100%",
    maxWidth: 420,
    borderRadius: 20,
    paddingVertical: 32,
    paddingHorizontal: 24,
    borderWidth: StyleSheet.hairlineWidth,
    ...Platform.select({
      ios: {
        shadowColor: "#000",
        shadowOffset: { width: 0, height: 6 },
        shadowOpacity: 0.25,
        shadowRadius: 20,
      },
      android: {
        elevation: 8,
      },
      default: {},
    }),
  },
  title: {
    fontSize: 22,
    fontWeight: "600",
    lineHeight: 30,
    textAlign: "center",
    marginBottom: 14,
  },
  body: {
    fontSize: 15,
    lineHeight: 22,
    textAlign: "center",
    marginBottom: 28,
  },
  cta: {
    borderRadius: 999,
    paddingVertical: 14,
    paddingHorizontal: 28,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 48, // Apple HIG touch target
  },
  ctaText: {
    fontSize: 16,
    fontWeight: "600",
    letterSpacing: 0.2,
  },
});
