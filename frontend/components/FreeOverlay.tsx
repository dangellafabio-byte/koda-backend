// components/FreeOverlay.tsx
// -----------------------------------------------------------------------------
// Overlay "modalità off" per utenti Free sulla home eclissi.
// Copre l'intera home con un rgba nero semi-trasparente e intercetta tutti
// i tap (tranne quelli sul pill "Lascia andare"): tap su eclissi/impostazioni/
// hands-free/scritte → mostra `PremiumTeaserToast` con link al paywall.
//
// Nota tecnica: usiamo `pointerEvents="box-none"` NON qui: qui è "box-only"
// perché vogliamo INTERCETTARE tutti i tap sulla home. Il pill LA vive fuori
// da questo overlay (top absolute), quindi resta cliccabile.
// -----------------------------------------------------------------------------

import React from "react";
import { View, Pressable, StyleSheet } from "react-native";

export interface FreeOverlayProps {
  onTap: () => void;
  /** Se true, l'overlay copre lo schermo. Se false, non è visibile. */
  visible: boolean;
}

export default function FreeOverlay({ onTap, visible }: FreeOverlayProps) {
  if (!visible) return null;
  return (
    <Pressable
      style={styles.overlay}
      onPress={onTap}
      testID="free-overlay"
      accessibilityLabel="La home è disponibile solo con Premium. Tocca per scoprire."
    >
      <View pointerEvents="none" style={styles.dim} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 800, // sopra la home ma sotto pill LA (che è z=850+) e modali (z=999)
  },
  dim: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.55)",
  },
});
