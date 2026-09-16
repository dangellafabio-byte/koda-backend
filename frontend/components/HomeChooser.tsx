// components/HomeChooser.tsx
// -----------------------------------------------------------------------------
// Prima schermata post-intro. Presenta due opzioni ALLA PARI, senza gerarchia
// di default:
//   1) Parla con Ollenya   → voce o testo
//   2) Lascia andare       → sfogo silenzioso, sempre gratuito
//
// L'eclissi (volto di Ollenya) NON compare qui — appare solo dentro la
// modalità "Ollenya". Così mantiene la sua identità di "presenza" senza
// dominare la gerarchia della schermata di scelta.
//
// Tutto il layout è responsive: due card verticali che occupano ~45% viewport
// ciascuna, separate da una linea sottile. La microcopy è emotiva, non
// commerciale ("Come vuoi stare, adesso?").
//
// Per gli utenti Free che hanno esaurito i 5 msg su Ollenya, la card
// "Parla con Ollenya" è ancora tappabile ma mostra un piccolo countdown
// discreto ("riprova tra 2g 5h") sotto la descrizione. Il tap fa comunque
// entrare in modalità Ollenya, che poi mostra il FreeLimitOverlay standard.
// -----------------------------------------------------------------------------

import React from "react";
import { View, Text, TouchableOpacity, StyleSheet, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../lib/theme";

// -----------------------------------------------------------------------------
// Icona Ollenya (orb piccolo): eclisse minimale con corona luminosa
// -----------------------------------------------------------------------------
function OllenyaGlyph({ size = 44 }: { size?: number }) {
  const { theme } = useTheme();
  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      {/* corona esterna: alone soft — usa primarySoftBg per identità Ollenya */}
      <View
        style={{
          position: "absolute",
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: theme.primary,
          opacity: 0.25,
        }}
      />
      {/* corpo principale eclissi: nero pieno (blu petrolio scuro) */}
      <View
        style={{
          width: size * 0.68,
          height: size * 0.68,
          borderRadius: (size * 0.68) / 2,
          backgroundColor: theme.primary,
        }}
      />
    </View>
  );
}

// -----------------------------------------------------------------------------
// Icona Lascia Andare (mezzaluna): simbolo di silenzio, oscurità gentile
// -----------------------------------------------------------------------------
function MoonGlyph({ size = 44 }: { size?: number }) {
  const { theme } = useTheme();
  const outer = size * 0.68;
  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      {/* cerchio pieno (grigio testo muted) */}
      <View
        style={{
          width: outer,
          height: outer,
          borderRadius: outer / 2,
          backgroundColor: theme.textMuted,
          opacity: 0.75,
        }}
      />
      {/* mezzaluna: cerchio offset dello stesso colore del background che "mangia" il primo */}
      <View
        style={{
          position: "absolute",
          left: (size - outer) / 2 + outer * 0.3,
          width: outer,
          height: outer,
          borderRadius: outer / 2,
          backgroundColor: theme.bg,
        }}
      />
    </View>
  );
}

// -----------------------------------------------------------------------------
// Props del chooser
// -----------------------------------------------------------------------------
export interface HomeChooserProps {
  onPickOllenya: () => void;
  onPickLasciaAndare: () => void;
  /** Se true (Premium/unlimited), nasconde qualunque contatore Free */
  isPaid?: boolean;
  /** Stato Free (turni rimasti + countdown natural) */
  freeStatus?: {
    remaining: number;
    limit: number;
    countdown_it?: string | null;
  } | null;
}

export default function HomeChooser({
  onPickOllenya,
  onPickLasciaAndare,
  isPaid = false,
  freeStatus,
}: HomeChooserProps) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();

  // Se Free ha esaurito i turni: countdown discreto
  const showCountdown = !isPaid && !!freeStatus && freeStatus.remaining === 0 && !!freeStatus.countdown_it;
  // Se Free non ha ancora esaurito: contatore residuo
  const showRemaining = !isPaid && !!freeStatus && freeStatus.remaining > 0 && freeStatus.remaining < freeStatus.limit;

  // Card height calc: viewport - safe areas - title (56) - divider (24) - padding (48), /2
  const usable = height - insets.top - insets.bottom - 128;
  const cardHeight = Math.max(220, Math.min(360, usable / 2));

  return (
    <View
      style={[
        styles.root,
        {
          backgroundColor: theme.bg,
          paddingTop: insets.top + 12,
          paddingBottom: insets.bottom + 12,
          paddingHorizontal: 20,
        },
      ]}
      testID="home-chooser"
    >
      {/* Microcopy silenziosa in alto */}
      <Text
        style={[styles.microTitle, { color: theme.textMuted }]}
        testID="home-chooser-title"
        accessibilityRole="header"
      >
        Come vuoi stare, adesso?
      </Text>

      {/* Card 1 — Parla con Ollenya */}
      <TouchableOpacity
        activeOpacity={0.75}
        onPress={onPickOllenya}
        style={[
          styles.card,
          {
            height: cardHeight,
            backgroundColor: theme.surface,
            borderColor: theme.border,
          },
        ]}
        testID="chooser-card-ollenya"
        accessibilityRole="button"
        accessibilityLabel="Parla con Ollenya, voce o testo"
      >
        <OllenyaGlyph size={54} />
        <Text style={[styles.cardTitle, { color: theme.text }]}>Parla con Ollenya</Text>
        <Text style={[styles.cardSubtitle, { color: theme.textMuted }]}>
          voce o testo, come vuoi
        </Text>
        {showCountdown ? (
          <Text
            style={[styles.cardHint, { color: theme.textDim }]}
            testID="chooser-ollenya-countdown"
          >
            riprova {freeStatus?.countdown_it}
          </Text>
        ) : showRemaining ? (
          <Text
            style={[styles.cardHint, { color: theme.textDim }]}
            testID="chooser-ollenya-remaining"
          >
            {freeStatus?.remaining}/{freeStatus?.limit} messaggi oggi
          </Text>
        ) : null}
      </TouchableOpacity>

      {/* Separatore sottile — visualmente comunica "due opzioni pari" */}
      <View style={[styles.divider, { backgroundColor: theme.divider }]} />

      {/* Card 2 — Lascia andare */}
      <TouchableOpacity
        activeOpacity={0.75}
        onPress={onPickLasciaAndare}
        style={[
          styles.card,
          {
            height: cardHeight,
            backgroundColor: theme.surface,
            borderColor: theme.border,
          },
        ]}
        testID="chooser-card-lascia-andare"
        accessibilityRole="button"
        accessibilityLabel="Lascia andare, sfoga in silenzio"
      >
        <MoonGlyph size={54} />
        <Text style={[styles.cardTitle, { color: theme.text }]}>Lascia andare</Text>
        <Text style={[styles.cardSubtitle, { color: theme.textMuted }]}>
          sfoga in silenzio, senza risposta
        </Text>
        <Text
          style={[styles.cardHint, { color: theme.textDim }]}
          testID="chooser-la-always-free"
        >
          sempre gratis, senza limiti
        </Text>
      </TouchableOpacity>
    </View>
  );
}

// -----------------------------------------------------------------------------
// Styles
// -----------------------------------------------------------------------------
const styles = StyleSheet.create({
  root: {
    flex: 1,
    justifyContent: "flex-start",
  },
  microTitle: {
    fontSize: 15,
    fontWeight: "500",
    textAlign: "center",
    marginTop: 12,
    marginBottom: 24,
    letterSpacing: 0.2,
  },
  card: {
    borderRadius: 20,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
    paddingVertical: 24,
    gap: 8,
  },
  cardTitle: {
    fontSize: 20,
    fontWeight: "600",
    marginTop: 6,
    letterSpacing: 0.1,
  },
  cardSubtitle: {
    fontSize: 13,
    fontWeight: "400",
    textAlign: "center",
    letterSpacing: 0.1,
  },
  cardHint: {
    fontSize: 11,
    fontWeight: "500",
    marginTop: 10,
    textAlign: "center",
    letterSpacing: 0.4,
    opacity: 0.85,
  },
  divider: {
    height: 1,
    width: "60%",
    alignSelf: "center",
    marginVertical: 12,
  },
});
