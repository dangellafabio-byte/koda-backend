// components/PremiumTeaserToast.tsx
// -----------------------------------------------------------------------------
// Toast breve, non bloccante, che compare quando un utente Free tocca elementi
// disabilitati della home (eclissi, impostazioni, hands-free) o l'overlay.
// Mostra "Questa è per la versione Premium →" con link al paywall.
// Auto-dismiss dopo 2500ms (governato dal parent via `visible` prop).
// Posizione: subito sotto safe-area top, centrato orizzontalmente, larghezza 90%.
// -----------------------------------------------------------------------------

import React, { useEffect, useRef } from "react";
import { Text, StyleSheet, TouchableOpacity, Animated, Easing } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../lib/theme";

export interface PremiumTeaserToastProps {
  visible: boolean;
  onPressLink: () => void;
}

export default function PremiumTeaserToast({ visible, onPressLink }: PremiumTeaserToastProps) {
  const insets = useSafeAreaInsets();
  const { theme } = useTheme();
  const anim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(anim, {
      toValue: visible ? 1 : 0,
      duration: 220,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [visible, anim]);

  return (
    <Animated.View
      pointerEvents={visible ? "box-none" : "none"}
      style={[
        styles.container,
        {
          top: insets.top + 12,
          opacity: anim,
          transform: [
            {
              translateY: anim.interpolate({
                inputRange: [0, 1],
                outputRange: [-14, 0],
              }),
            },
          ],
        },
      ]}
    >
      <TouchableOpacity
        style={[
          styles.pill,
          {
            backgroundColor: theme.surface,
            borderColor: theme.border,
          },
        ]}
        activeOpacity={0.85}
        onPress={onPressLink}
        testID="premium-teaser-toast"
        accessibilityLabel="Questa è per la versione Premium. Tocca per attivarla."
      >
        <Text style={[styles.text, { color: theme.text }]}>
          Questa è per la versione Premium{" "}
          <Text style={[styles.arrow, { color: theme.primary }]}>→</Text>
        </Text>
      </TouchableOpacity>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: "absolute",
    left: 0,
    right: 0,
    alignItems: "center",
    zIndex: 900, // sopra overlay (800), sotto modali (999)
  },
  pill: {
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderRadius: 999,
    borderWidth: 1,
    maxWidth: "90%",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 10,
    elevation: 6,
  },
  text: {
    fontSize: 14,
    fontWeight: "500",
    letterSpacing: 0.1,
    textAlign: "center",
  },
  arrow: {
    fontWeight: "700",
  },
});
