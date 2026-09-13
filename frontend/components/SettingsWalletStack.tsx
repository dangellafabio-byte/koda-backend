/**
 * SettingsWalletStack.tsx — v2 (Fabio 2026-06)
 * ============================================
 * Ricreato per replicare fedelmente il pattern **Apple Wallet reale**:
 *
 *   Vista BROWSE (default all'apertura):
 *     ┌────────────────────┐
 *     │ 💎 Piano attivo    │  ← card 1, header visibile
 *     ├────────────────────┤
 *     │ 💬 Comportamento   │  ← card 2, sotto la 1
 *     ├────────────────────┤
 *     │ 🎙️ Voce            │
 *     └────────────────────┘
 *     Tutte le card impilate in unica schermata SENZA scroll — vedi TUTTE
 *     le card contemporaneamente e tocchi direttamente quella che vuoi.
 *
 *   Vista EXPANDED (tap su una card):
 *     ┌────────────────────┐
 *     │ 💎 Piano attivo    │
 *     │                    │
 *     │  ...controlli...   │  ← card espansa a tutto schermo
 *     │                    │
 *     └────────────────────┘
 *     ▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁ ← peek minimo delle altre in fondo
 *     Tap sulla card espansa (o su "X") → torna a browse.
 *
 * Sfondo OPACO (theme.bg), copre completamente la home sotto.
 * Nessun scroll verticale sulla vista browse. Nessuna sovrapposizione con
 * la home sottostante.
 *
 * Fabio 2026-06 iter 2:
 *   - v1 (scrollstack) SCARTATO: era ScrollView con snap, si vedeva la home
 *     sotto tra le card. Non è quello che chiede Wallet.
 *   - v2 (questo): browse-all-visible + expand-on-tap, sfondo opaco.
 */
import React, { useMemo, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Dimensions,
  TouchableOpacity,
  ScrollView,
  Platform,
} from "react-native";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  withSpring,
} from "react-native-reanimated";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "../lib/theme";

export type SettingsCard = {
  key: string;
  icon: string;
  title: string;
  description?: string;
  count?: number;
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

// Altezza dell'header (titolo Impostazioni + subtitle + hint) fisso in cima.
const HEADER_H = Platform.OS === "ios" ? 130 : 120;
// Altezza della "testata" visibile in vista browse per ogni card.
const CARD_HEADER_H = 100;
// Peek delle card compresse in fondo quando UNA è espansa.
const PEEK_H = 12;

export default function SettingsWalletStack({
  cards,
  onClose,
  title = "Impostazioni",
  subtitle = "Personalizza Koda come vuoi",
  hint = "Tocca una scheda per aprirla.",
}: Props) {
  const { theme } = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);

  // Area disponibile per lo stack (tolto header + safe bottom)
  const stackTop = HEADER_H;
  const stackHeight = SCREEN_H - stackTop - 20;
  const n = cards.length;
  // In vista browse: ogni card header alta CARD_HEADER_H con overlap piccolo
  // per lasciarne visibile un tag. Se ci stanno tutte le testate a
  // CARD_HEADER_H, uso quello; altrimenti riduco per stare in una schermata.
  const browseCardStep = Math.min(
    CARD_HEADER_H,
    Math.max(72, (stackHeight - CARD_HEADER_H) / Math.max(1, n - 1))
  );
  // Altezza card espansa: quasi tutta l'area stack, meno peek delle nascoste.
  const collapsedCount = Math.max(0, n - 1);
  const expandedH = stackHeight - collapsedCount * PEEK_H - 12;

  return (
    <View style={styles.container} testID="settings-wallet-stack">
      {/* HEADER — fisso, opaco */}
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.subtitle}>{subtitle}</Text>
          <Text style={styles.hint}>
            {expandedKey ? "Tocca l'intestazione per tornare indietro." : hint}
          </Text>
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

      {/* STACK — sfondo opaco, area assoluta sotto l'header */}
      <View style={styles.stackArea}>
        {cards.map((card, i) => {
          const isExpanded = expandedKey === card.key;
          const anyExpanded = expandedKey !== null;
          return (
            <WalletCardItem
              key={card.key}
              card={card}
              index={i}
              total={n}
              isExpanded={isExpanded}
              anyExpanded={anyExpanded}
              onOpen={() => setExpandedKey(card.key)}
              onClose={() => setExpandedKey(null)}
              browseCardStep={browseCardStep}
              expandedH={expandedH}
              stackHeight={stackHeight}
              theme={theme}
              styles={styles}
              expandedKey={expandedKey}
              expandedIndex={
                expandedKey ? cards.findIndex((c) => c.key === expandedKey) : -1
              }
            />
          );
        })}
      </View>
    </View>
  );
}

// ============================================================================
// WalletCardItem — singola card con animazione position/height
// ============================================================================

type ItemProps = {
  card: SettingsCard;
  index: number;
  total: number;
  isExpanded: boolean;
  anyExpanded: boolean;
  onOpen: () => void;
  onClose: () => void;
  browseCardStep: number;
  expandedH: number;
  stackHeight: number;
  theme: any;
  styles: any;
  expandedKey: string | null;
  expandedIndex: number;
};

function WalletCardItem({
  card,
  index,
  total,
  isExpanded,
  anyExpanded,
  onOpen,
  onClose,
  browseCardStep,
  expandedH,
  stackHeight,
  theme,
  styles,
  expandedKey,
  expandedIndex,
}: ItemProps) {
  // Posizioni target in base allo state.
  // BROWSE state: card i-esima ha top = i * browseCardStep, altezza CARD_HEADER_H (con contenuto nascosto).
  // EXPANDED state (una qualsiasi espansa):
  //   - se questa è quella espansa: top piccolo (subito sotto header), height = expandedH
  //   - se questa è PRIMA di quella espansa: compressa in cima (i * PEEK_H)
  //   - se questa è DOPO quella espansa: compressa in fondo (stackHeight - (total-i)*PEEK_H)
  const browseTop = index * browseCardStep;

  let targetTop = browseTop;
  let targetHeight = CARD_HEADER_H + 12; // card in vista browse (solo header + un po')
  let targetOpacity = 1;
  let targetZ = index;

  if (anyExpanded) {
    if (isExpanded) {
      targetTop = expandedIndex * PEEK_H + 8;
      targetHeight = expandedH;
      targetZ = 100;
    } else if (index < expandedIndex) {
      // Compressa sopra la espansa
      targetTop = index * PEEK_H;
      targetHeight = CARD_HEADER_H;
      targetOpacity = 0.55;
      targetZ = index;
    } else {
      // Compressa sotto la espansa (peek in fondo)
      const offsetFromEnd = total - 1 - index;
      targetTop = stackHeight - PEEK_H * (offsetFromEnd + 1) - CARD_HEADER_H + 20;
      targetHeight = CARD_HEADER_H;
      targetOpacity = 0.55;
      targetZ = index;
    }
  }

  // Reanimated shared values per animare
  const topSV = useSharedValue(targetTop);
  const heightSV = useSharedValue(targetHeight);
  const opacitySV = useSharedValue(targetOpacity);

  // Sync target quando cambia state
  React.useEffect(() => {
    topSV.value = withSpring(targetTop, { damping: 20, stiffness: 160 });
    heightSV.value = withSpring(targetHeight, { damping: 22, stiffness: 180 });
    opacitySV.value = withTiming(targetOpacity, { duration: 220 });
  }, [targetTop, targetHeight, targetOpacity, topSV, heightSV, opacitySV]);

  const aStyle = useAnimatedStyle(() => ({
    top: topSV.value,
    height: heightSV.value,
    opacity: opacitySV.value,
  }));

  // Header tap: se in browse, apre; se espansa, chiude
  const onHeaderPress = () => {
    if (isExpanded) onClose();
    else onOpen();
  };

  return (
    <Animated.View
      style={[styles.cardWrap, aStyle, { zIndex: targetZ }]}
      testID={`settings-card-${card.key}`}
    >
      <View style={styles.card}>
        {/* Header cliccabile — apre/chiude */}
        <TouchableOpacity
          activeOpacity={0.85}
          onPress={onHeaderPress}
          style={styles.cardHeaderTouch}
        >
          <View style={styles.iconBubble}>
            <Text style={styles.iconEmoji}>{card.icon}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.cardTitle}>{card.title}</Text>
            {card.description ? (
              <Text style={styles.cardDescription} numberOfLines={2}>
                {card.description}
              </Text>
            ) : null}
          </View>
          {typeof card.count === "number" && card.count > 0 ? (
            <View style={styles.countBadge}>
              <Text style={styles.countText}>{card.count}</Text>
            </View>
          ) : null}
          {isExpanded ? (
            <Ionicons
              name="chevron-down"
              size={22}
              color={theme.textDim}
              style={{ marginLeft: 6 }}
            />
          ) : (
            <Ionicons
              name="chevron-forward"
              size={22}
              color={theme.textDim}
              style={{ marginLeft: 6 }}
            />
          )}
        </TouchableOpacity>

        {/* Body — visibile solo quando espansa */}
        {isExpanded ? (
          <ScrollView
            style={styles.cardBody}
            contentContainerStyle={{ paddingBottom: 24 }}
            showsVerticalScrollIndicator={false}
            nestedScrollEnabled
          >
            {card.body}
          </ScrollView>
        ) : null}
      </View>
    </Animated.View>
  );
}

function makeStyles(t: any) {
  return StyleSheet.create({
    // Sfondo pieno opaco — copre completamente la home sotto.
    container: {
      flex: 1,
      backgroundColor: t.bg,
    },
    header: {
      flexDirection: "row",
      alignItems: "flex-start",
      paddingHorizontal: 22,
      paddingTop: Platform.OS === "ios" ? 12 : 16,
      paddingBottom: 8,
      backgroundColor: t.bg,
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
    stackArea: {
      flex: 1,
      position: "relative",
      paddingHorizontal: 14,
    },
    cardWrap: {
      position: "absolute",
      left: 14,
      right: 14,
    },
    card: {
      flex: 1,
      backgroundColor: t.surface,
      borderRadius: 22,
      borderWidth: 1,
      borderColor: t.border,
      overflow: "hidden",
      // Shadow per profondità wallet-like
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 8 },
      shadowOpacity: 0.4,
      shadowRadius: 14,
      elevation: 10,
    },
    cardHeaderTouch: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingHorizontal: 16,
      paddingVertical: 16,
      height: CARD_HEADER_H,
    },
    iconBubble: {
      width: 48,
      height: 48,
      borderRadius: 14,
      backgroundColor: t.surfaceAlt,
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 1,
      borderColor: t.border,
    },
    iconEmoji: {
      fontSize: 24,
      lineHeight: 28,
    },
    cardTitle: {
      color: t.text,
      fontSize: 19,
      fontWeight: "800",
      letterSpacing: -0.3,
    },
    cardDescription: {
      color: t.textDim,
      fontSize: 12,
      lineHeight: 16,
      marginTop: 2,
    },
    countBadge: {
      backgroundColor: t.surfaceAlt,
      borderRadius: 999,
      paddingHorizontal: 9,
      paddingVertical: 3,
      borderWidth: 1,
      borderColor: t.border,
      minWidth: 26,
      alignItems: "center",
    },
    countText: {
      color: t.textDim,
      fontSize: 11,
      fontWeight: "700",
    },
    cardBody: {
      flex: 1,
      paddingHorizontal: 18,
    },
  });
}
