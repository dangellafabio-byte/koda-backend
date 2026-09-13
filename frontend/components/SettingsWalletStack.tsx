/**
 * SettingsWalletStack.tsx
 * ========================
 * Refactor del Settings modal in stile Apple Wallet **verticale**:
 * card sfalsate impilate verticalmente, swipe su/giù, snap magnetico.
 * Peek delle card sopra/sotto sempre visibile — l'utente non vede mai
 * una card intera isolata, come nel Wallet iPhone.
 *
 * Design (Fabio 2026-06):
 *  - Header "Impostazioni" fisso in cima
 *  - Sotto: subtitle + hint "Scorri per esplorare"
 *  - ScrollView verticale con card di altezza fissa (~76% viewport)
 *  - Snap magnetico su ogni card
 *  - Card attiva: piena opacità, scale 1.0
 *  - Card non-attive: opacità ridotta, leggera scale-down → effetto "stack"
 *  - Page dots in fondo (opzionale, hidden se scroll continuo)
 *
 * NB: NON è orizzontale. Fabio ha già uno swipe orizzontale sull'app
 * (index scroll) → collision. Solo verticale.
 */
import React, { useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Dimensions,
  Animated,
  ScrollView,
  TouchableOpacity,
  Platform,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "../lib/theme";

export type SettingsCard = {
  /** Chiave univoca (usata per React key + testID) */
  key: string;
  /** Emoji o icona breve mostrata nell'header della card */
  icon: string;
  /** Titolo principale, grande */
  title: string;
  /** Descrizione breve sotto il titolo (1-2 righe) */
  description?: string;
  /** Counter opzionale "N impostazioni" mostrato in alto a destra */
  count?: number;
  /**
   * Corpo della card — JSX già renderizzato dal chiamante con accesso al
   * suo scope (state, callback, refs). Il wallet non gestisce i controlli,
   * si limita a impilarli e scrollarli.
   */
  body: React.ReactNode;
};

type Props = {
  cards: SettingsCard[];
  onClose: () => void;
  title?: string;
  subtitle?: string;
  hint?: string;
};

const { height: SCREEN_H } = Dimensions.get("window");

// Altezza fissa card (76% viewport). Più bassa dello schermo intero così
// vediamo sempre peek della card sopra/sotto → effetto Wallet stack.
const CARD_HEIGHT = Math.max(560, Math.round(SCREEN_H * 0.76));
const CARD_GAP = 14;
const SNAP_INTERVAL = CARD_HEIGHT + CARD_GAP;

export default function SettingsWalletStack({
  cards,
  onClose,
  title = "Impostazioni",
  subtitle = "Personalizza Koda come vuoi",
  hint = "Scorri le schede per esplorare tutte le sezioni.",
}: Props) {
  const { theme } = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const scrollY = useRef(new Animated.Value(0)).current;
  const [activeIndex, setActiveIndex] = useState(0);

  const handleScroll = Animated.event(
    [{ nativeEvent: { contentOffset: { y: scrollY } } }],
    {
      useNativeDriver: true,
      listener: (e: any) => {
        const y = e.nativeEvent.contentOffset.y;
        const idx = Math.max(0, Math.min(cards.length - 1, Math.round(y / SNAP_INTERVAL)));
        if (idx !== activeIndex) setActiveIndex(idx);
      },
    }
  );

  return (
    <View style={styles.container} testID="settings-wallet-stack">
      {/* HEADER — fisso, non scrolla con le card */}
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.subtitle}>{subtitle}</Text>
          <Text style={styles.hint}>{hint}</Text>
        </View>
        <TouchableOpacity
          onPress={onClose}
          style={styles.closeBtn}
          accessibilityLabel="Chiudi impostazioni"
          testID="settings-wallet-close"
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Ionicons name="close" size={22} color={theme.text} />
        </TouchableOpacity>
      </View>

      {/* STACK DELLE CARD — scroll verticale con snap magnetico */}
      <Animated.ScrollView
        style={styles.scroll}
        contentContainerStyle={{
          paddingTop: 20,
          paddingBottom: SCREEN_H * 0.24, // permette all'ultima card di raggiungere il centro
        }}
        showsVerticalScrollIndicator={false}
        snapToInterval={SNAP_INTERVAL}
        decelerationRate="fast"
        snapToAlignment="start"
        onScroll={handleScroll}
        scrollEventThrottle={16}
      >
        {cards.map((card, i) => {
          // Animazione: la card active è a scale 1, opacità 1.
          // Le card sopra/sotto sono scaled 0.94 + opacità 0.55 → effetto stack.
          const inputRange = [
            (i - 1) * SNAP_INTERVAL,
            i * SNAP_INTERVAL,
            (i + 1) * SNAP_INTERVAL,
          ];
          const scale = scrollY.interpolate({
            inputRange,
            outputRange: [0.94, 1, 0.94],
            extrapolate: "clamp",
          });
          const opacity = scrollY.interpolate({
            inputRange,
            outputRange: [0.55, 1, 0.55],
            extrapolate: "clamp",
          });

          return (
            <Animated.View
              key={card.key}
              style={[
                styles.cardOuter,
                { height: CARD_HEIGHT, marginBottom: CARD_GAP, transform: [{ scale }], opacity },
              ]}
              testID={`settings-card-${card.key}`}
            >
              <View style={styles.card}>
                {/* HEADER CARD: icona + titolo + counter */}
                <View style={styles.cardHeader}>
                  <View style={styles.iconBubble}>
                    <Text style={styles.iconEmoji}>{card.icon}</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.cardTitle}>{card.title}</Text>
                    {card.description ? (
                      <Text style={styles.cardDescription}>{card.description}</Text>
                    ) : null}
                  </View>
                  {typeof card.count === "number" && card.count > 0 ? (
                    <View style={styles.countBadge}>
                      <Text style={styles.countText}>{card.count}</Text>
                    </View>
                  ) : null}
                </View>

                {/* BODY CARD: contenuto scrollabile se troppo lungo */}
                <ScrollView
                  style={styles.cardBody}
                  contentContainerStyle={{ paddingBottom: 20 }}
                  showsVerticalScrollIndicator={false}
                  nestedScrollEnabled
                >
                  {card.body}
                </ScrollView>
              </View>
            </Animated.View>
          );
        })}
      </Animated.ScrollView>

      {/* PAGE DOTS — indicator di posizione */}
      <View style={styles.dotsRow} pointerEvents="none">
        {cards.map((_, i) => (
          <View
            key={i}
            style={[
              styles.dot,
              i === activeIndex ? styles.dotActive : styles.dotIdle,
            ]}
          />
        ))}
      </View>
    </View>
  );
}

function makeStyles(t: any) {
  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: t.background,
    },
    header: {
      flexDirection: "row",
      alignItems: "flex-start",
      paddingHorizontal: 22,
      paddingTop: Platform.OS === "ios" ? 8 : 12,
      paddingBottom: 4,
    },
    title: {
      color: t.text,
      fontSize: 32,
      fontWeight: "800",
      letterSpacing: -0.5,
    },
    subtitle: {
      color: t.text,
      fontSize: 15,
      fontWeight: "600",
      marginTop: 4,
      opacity: 0.85,
    },
    hint: {
      color: t.textDim,
      fontSize: 12,
      marginTop: 4,
    },
    closeBtn: {
      width: 40,
      height: 40,
      borderRadius: 20,
      backgroundColor: t.surfaceAlt,
      alignItems: "center",
      justifyContent: "center",
      marginTop: 6,
    },
    scroll: {
      flex: 1,
    },
    cardOuter: {
      paddingHorizontal: 18,
    },
    card: {
      flex: 1,
      backgroundColor: t.surface,
      borderRadius: 26,
      borderWidth: 1,
      borderColor: t.border,
      padding: 22,
      // Shadow iOS + Android per profondità wallet-like
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 8 },
      shadowOpacity: 0.35,
      shadowRadius: 16,
      elevation: 8,
    },
    cardHeader: {
      flexDirection: "row",
      alignItems: "center",
      gap: 14,
      marginBottom: 18,
    },
    iconBubble: {
      width: 54,
      height: 54,
      borderRadius: 16,
      backgroundColor: t.surfaceAlt,
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 1,
      borderColor: t.border,
    },
    iconEmoji: {
      fontSize: 26,
      lineHeight: 30,
    },
    cardTitle: {
      color: t.text,
      fontSize: 22,
      fontWeight: "800",
      letterSpacing: -0.3,
    },
    cardDescription: {
      color: t.textDim,
      fontSize: 13,
      lineHeight: 18,
      marginTop: 2,
    },
    countBadge: {
      backgroundColor: t.surfaceAlt,
      borderRadius: 999,
      paddingHorizontal: 10,
      paddingVertical: 4,
      borderWidth: 1,
      borderColor: t.border,
    },
    countText: {
      color: t.textDim,
      fontSize: 11,
      fontWeight: "700",
    },
    cardBody: {
      flex: 1,
    },
    dotsRow: {
      position: "absolute",
      bottom: 20,
      left: 0,
      right: 0,
      flexDirection: "row",
      justifyContent: "center",
      alignItems: "center",
      gap: 6,
    },
    dot: {
      width: 6,
      height: 6,
      borderRadius: 3,
    },
    dotActive: {
      backgroundColor: t.primary,
      width: 20,
    },
    dotIdle: {
      backgroundColor: t.textDim,
      opacity: 0.35,
    },
  });
}
