/**
 * SettingsWalletStack — v65.49 (Rolodex compatto, layout fluido)
 *
 * Modifiche rispetto v65.47:
 *   1. Compattato: CARD_HEADER_H 84 → 58, gap 8 → 6, description single-line.
 *      Le 9 card entrano tutte nel viewport iPhone standard senza scroll.
 *   2. Fluidità: rimpiazzato l'height-animate con onLayout (misura → setState
 *      → re-render → animate) con Reanimated `LinearTransition.layout` che
 *      interpola nativamente l'altezza del wrapper senza misurazioni JS.
 *      Zero scatti, 60fps garantiti anche su Android.
 *   3. Body condizionale: renderizzato solo se `isExpanded` → niente
 *      overhead di misurazione invisibile.
 *
 * Fabio 2026-06 specifica:
 *   "Voglio un Rolodex verticale, non un accordion. Le card scorrono su/giù,
 *    intestazioni sempre visibili, nessuna overlay, versione sempre in fondo,
 *    swipe orizzontale libero per back-to-home."
 */
import React, { useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
} from "react-native";
import Animated, { LinearTransition, FadeIn, FadeOut } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useTheme, type Palette } from "../lib/theme";

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
  version?: string;
  buildTag?: string;
  runtimeInfo?: string;
  onVersionTap?: () => void;
};

// Compact layout: 9 card entrano in un iPhone 14 (844px) senza scroll iniziale
const CARD_HEADER_H = 58;
const CARD_GAP = 6;

export default function SettingsWalletStack({
  cards,
  onClose,
  title = "Impostazioni",
  subtitle = "Personalizza Ollenya come vuoi",
  version,
  buildTag,
  runtimeInfo,
  onVersionTap,
}: Props) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();

  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const cardOffsets = useRef<Record<string, number>>({}).current;
  const scrollRef = useRef<ScrollView>(null);

  const styles = useMemo(() => makeStyles(theme, insets), [theme, insets]);

  const onCardTap = (key: string) => {
    const isCurrentlyExpanded = expandedKey === key;
    setExpandedKey(isCurrentlyExpanded ? null : key);

    if (!isCurrentlyExpanded) {
      // Attende che LinearTransition inizi (~60ms) prima di scrollare
      setTimeout(() => {
        const y = cardOffsets[key];
        if (typeof y === "number" && scrollRef.current) {
          scrollRef.current.scrollTo({ y: Math.max(0, y - 8), animated: true });
        }
      }, 80);
    }
  };

  return (
    <View style={styles.root}>
      {/* Header fisso */}
      <View style={styles.headerBar}>
        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle}>{title}</Text>
          <Text style={styles.headerSubtitle}>{subtitle}</Text>
        </View>
        <TouchableOpacity
          onPress={onClose}
          style={styles.closeBtn}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Ionicons name="close" size={20} color={theme.text} />
        </TouchableOpacity>
      </View>

      {/* Lista verticale — Rolodex */}
      <ScrollView
        ref={scrollRef}
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        overScrollMode="never"
      >
        {cards.map((card) => (
          <RolodexCard
            key={card.key}
            card={card}
            isExpanded={expandedKey === card.key}
            onTap={() => onCardTap(card.key)}
            theme={theme}
            styles={styles}
            onLayoutY={(y) => {
              cardOffsets[card.key] = y;
            }}
          />
        ))}

        {/* Versione app inline */}
        {version ? (
          <View style={styles.versionBlock}>
            <TouchableOpacity onPress={onVersionTap} activeOpacity={0.7}>
              <Text style={styles.versionText}>Ollenya v{version}</Text>
              {buildTag ? (
                <Text style={styles.buildTagText}>{buildTag}</Text>
              ) : null}
              {runtimeInfo ? (
                <Text style={styles.runtimeText}>{runtimeInfo}</Text>
              ) : null}
            </TouchableOpacity>
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

// === Sub-component: card con LinearTransition (fluidità nativa) ===
type CardProps = {
  card: SettingsCard;
  isExpanded: boolean;
  onTap: () => void;
  theme: Palette;
  styles: ReturnType<typeof makeStyles>;
  onLayoutY: (y: number) => void;
};

function RolodexCard({ card, isExpanded, onTap, theme, styles, onLayoutY }: CardProps) {
  return (
    <Animated.View
      layout={LinearTransition.duration(280)}
      style={styles.card}
      onLayout={(e) => onLayoutY(e.nativeEvent.layout.y)}
    >
      {/* Header sempre visibile */}
      <TouchableOpacity
        activeOpacity={0.7}
        onPress={onTap}
        style={styles.cardHeader}
      >
        <View style={styles.cardIconWrap}>
          <Text style={styles.cardIcon}>{card.icon}</Text>
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.cardTitle} numberOfLines={1}>
            {card.title}
          </Text>
          {card.description ? (
            <Text style={styles.cardDesc} numberOfLines={1}>
              {card.description}
            </Text>
          ) : null}
        </View>
        <View style={styles.chevronWrap}>
          {typeof card.count === "number" && card.count > 0 ? (
            <View style={styles.countPill}>
              <Text style={styles.countText}>{card.count}</Text>
            </View>
          ) : null}
          <Ionicons
            name={isExpanded ? "chevron-up" : "chevron-forward"}
            size={16}
            color={theme.text + "AA"}
          />
        </View>
      </TouchableOpacity>

      {/* Body renderizzato solo quando espanso — LinearTransition gestisce
          l'animazione dell'altezza del wrapper in modo nativo */}
      {isExpanded ? (
        <Animated.View
          entering={FadeIn.duration(180).delay(80)}
          exiting={FadeOut.duration(120)}
          style={styles.bodyContainer}
        >
          {card.body}
        </Animated.View>
      ) : null}
    </Animated.View>
  );
}

// === Styles ===
function makeStyles(
  theme: Palette,
  insets: { top: number; bottom: number; left: number; right: number },
) {
  return StyleSheet.create({
    root: {
      flex: 1,
      // Safety net: se theme fosse undefined (regressione), NO schermo bianco Android
      backgroundColor: theme?.bg || "#1F1A36",
    },
    headerBar: {
      flexDirection: "row",
      alignItems: "flex-start",
      paddingTop: insets.top + 6,
      paddingHorizontal: 18,
      paddingBottom: 10,
    },
    headerTitle: {
      color: theme.text,
      fontSize: 26,
      fontWeight: "700",
      letterSpacing: -0.4,
    },
    headerSubtitle: {
      color: theme.text + "AA",
      fontSize: 13,
      marginTop: 2,
      fontWeight: "500",
    },
    closeBtn: {
      width: 32,
      height: 32,
      borderRadius: 16,
      backgroundColor: theme.text + "15",
      alignItems: "center",
      justifyContent: "center",
      marginTop: 4,
    },
    scroll: {
      flex: 1,
    },
    scrollContent: {
      paddingHorizontal: 14,
      paddingBottom: insets.bottom + 24,
      gap: CARD_GAP,
    },
    card: {
      backgroundColor: theme.text + "10",
      borderRadius: 12,
      borderWidth: 1,
      borderColor: theme.text + "20",
      overflow: "hidden",
    },
    cardHeader: {
      flexDirection: "row",
      alignItems: "center",
      height: CARD_HEADER_H,
      paddingHorizontal: 12,
      gap: 10,
    },
    cardIconWrap: {
      width: 34,
      height: 34,
      borderRadius: 9,
      backgroundColor: theme.text + "10",
      alignItems: "center",
      justifyContent: "center",
    },
    cardIcon: {
      fontSize: 18,
    },
    cardTitle: {
      color: theme.text,
      fontSize: 15,
      fontWeight: "600",
    },
    cardDesc: {
      color: theme.text + "88",
      fontSize: 11,
      marginTop: 1,
      lineHeight: 14,
    },
    chevronWrap: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
    },
    countPill: {
      minWidth: 20,
      height: 20,
      paddingHorizontal: 6,
      borderRadius: 10,
      backgroundColor: theme.text + "18",
      alignItems: "center",
      justifyContent: "center",
    },
    countText: {
      color: theme.text,
      fontSize: 11,
      fontWeight: "600",
    },
    bodyContainer: {
      paddingHorizontal: 12,
      paddingBottom: 14,
      paddingTop: 2,
    },
    versionBlock: {
      alignItems: "center",
      marginTop: 16,
      paddingVertical: 10,
    },
    versionText: {
      color: theme.text + "66",
      fontSize: 12,
      fontStyle: "italic",
      textAlign: "center",
    },
    buildTagText: {
      color: theme.text + "44",
      fontSize: 10,
      marginTop: 3,
      textAlign: "center",
      fontFamily: "monospace",
    },
    runtimeText: {
      color: theme.text + "33",
      fontSize: 9,
      marginTop: 1,
      textAlign: "center",
      fontFamily: "monospace",
    },
  });
}
