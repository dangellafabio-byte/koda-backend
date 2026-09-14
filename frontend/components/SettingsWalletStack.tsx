/**
 * SettingsWalletStack — v65.47 (Rolodex verticale, riscritto)
 *
 * Fabio 2026-06 specifica definitiva:
 *   "Voglio un Rolodex verticale, non un accordion. Le schede devono
 *    scorrere su e giù come un mazzo fisico, ma devono rimanere TUTTE
 *    visibili nelle loro intestazioni. Nessuna card deve sovrapporsi
 *    alle altre, nessun contenuto deve essere in overlay, e soprattutto
 *    la versione dell'app in fondo deve rimanere sempre visibile.
 *    Lo swipe orizzontale non va toccato perché è già riservato al
 *    ritorno alla Home."
 *
 * Pattern implementativo:
 *   - ScrollView verticale contenitore (scroll nativo = "swipe verticale")
 *   - Ogni card è una `Animated.View` con altezza dinamica animata (Reanimated)
 *   - Compact: solo header ~84px visibile
 *   - Expanded: header + body con altezza reale del contenuto (misurata via
 *     onLayout su un View invisibile "measurer")
 *   - Le card espanse occupano spazio VERO nel flusso — le altre scorrono
 *     naturalmente su/giù, mai coperte, mai in overlay
 *   - Versione app inline in fondo → sempre raggiungibile scrollando
 *   - Al tap, `scrollTo({ y: cardOffsetY })` porta la card selezionata
 *     in cima alla viewport per lettura
 *
 * Nessun magnetic snap, nessun `absoluteFill`, nessun `peek header`
 * flottante. Puro flusso verticale ScrollView-compatibile con
 * `momentumScroll` iOS nativo.
 */
import React, { useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
} from "react-native";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  Easing,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
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
  version?: string;
  buildTag?: string;
  runtimeInfo?: string;
  onVersionTap?: () => void;
};

// Altezza header compact (solo intestazione visibile)
const CARD_HEADER_H = 84;
// Padding verticale interno del body espanso
const BODY_PAD_V = 16;

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
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  // Card espansa (una alla volta per pulizia visiva)
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  // Offset Y di ogni card nella ScrollView (aggiornato da onLayout)
  const cardOffsets = useRef<Record<string, number>>({}).current;
  const scrollRef = useRef<ScrollView>(null);

  const styles = useMemo(() => makeStyles(theme, insets), [theme, insets]);

  // Tap su card: toggle espansa + scrolla per portarla in vista
  const onCardTap = (key: string) => {
    const isCurrentlyExpanded = expandedKey === key;
    setExpandedKey(isCurrentlyExpanded ? null : key);

    if (!isCurrentlyExpanded) {
      // Piccolo delay per lasciare che l'altezza cresca prima di scrollare
      setTimeout(() => {
        const y = cardOffsets[key];
        if (typeof y === "number" && scrollRef.current) {
          scrollRef.current.scrollTo({ y: Math.max(0, y - 12), animated: true });
        }
      }, 120);
    }
  };

  return (
    <View style={styles.root}>
      {/* Header fisso in cima (non scorre) */}
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
          <Ionicons name="close" size={22} color={theme.text} />
        </TouchableOpacity>
      </View>

      {/* Lista scorrevole verticale — questo è il "Rolodex" */}
      <ScrollView
        ref={scrollRef}
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        overScrollMode="never"
        // Scroll fluido stile iOS. Il gesto orizzontale NON è catturato
        // qui → resta libero per il "swipe back to Home" dello stack.
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

        {/* Versione app inline — sempre raggiungibile scrollando in fondo */}
        {version ? (
          <View style={styles.versionBlock}>
            <TouchableOpacity onPress={onVersionTap} activeOpacity={0.7}>
              <Text style={styles.versionText}>
                Ollenya v{version}
              </Text>
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

// === Sub-component: singola card con altezza animata ===
type CardProps = {
  card: SettingsCard;
  isExpanded: boolean;
  onTap: () => void;
  theme: ReturnType<typeof useTheme>;
  styles: ReturnType<typeof makeStyles>;
  onLayoutY: (y: number) => void;
};

function RolodexCard({ card, isExpanded, onTap, theme, styles, onLayoutY }: CardProps) {
  // Altezza reale del body (misurata invisibilmente al primo render)
  const [bodyH, setBodyH] = useState(0);
  const targetH = isExpanded ? CARD_HEADER_H + bodyH + BODY_PAD_V * 2 : CARD_HEADER_H;
  const heightSV = useSharedValue(CARD_HEADER_H);

  React.useEffect(() => {
    heightSV.value = withTiming(targetH, {
      duration: 380,
      easing: Easing.inOut(Easing.cubic),
    });
  }, [targetH, heightSV]);

  const animatedContainer = useAnimatedStyle(() => ({
    height: heightSV.value,
  }));

  return (
    <Animated.View
      style={[styles.card, animatedContainer]}
      onLayout={(e) => onLayoutY(e.nativeEvent.layout.y)}
    >
      {/* Header sempre visibile (tap = toggle) */}
      <TouchableOpacity
        activeOpacity={0.85}
        onPress={onTap}
        style={styles.cardHeader}
      >
        <View style={styles.cardIconWrap}>
          <Text style={styles.cardIcon}>{card.icon}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.cardTitle}>{card.title}</Text>
          {card.description ? (
            <Text style={styles.cardDesc} numberOfLines={2}>
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
            size={20}
            color={theme.text + "AA"}
          />
        </View>
      </TouchableOpacity>

      {/* Body — sempre renderizzato (per misurare l'altezza),
          ma visibile solo quando espansa (opacity + overflow) */}
      <View
        style={[
          styles.bodyContainer,
          { opacity: isExpanded ? 1 : 0 },
        ]}
        pointerEvents={isExpanded ? "auto" : "none"}
        onLayout={(e) => {
          const h = e.nativeEvent.layout.height;
          if (h && Math.abs(h - bodyH) > 2) setBodyH(h);
        }}
      >
        {card.body}
      </View>
    </Animated.View>
  );
}

// === Styles ===
function makeStyles(theme: ReturnType<typeof useTheme>, insets: { top: number; bottom: number; left: number; right: number }) {
  return StyleSheet.create({
    root: {
      flex: 1,
      backgroundColor: theme.bg,
    },
    headerBar: {
      flexDirection: "row",
      alignItems: "flex-start",
      paddingTop: insets.top + 8,
      paddingHorizontal: 20,
      paddingBottom: 12,
    },
    headerTitle: {
      color: theme.text,
      fontSize: 32,
      fontWeight: "700",
      letterSpacing: -0.5,
    },
    headerSubtitle: {
      color: theme.text + "AA",
      fontSize: 15,
      marginTop: 4,
      fontWeight: "500",
    },
    closeBtn: {
      width: 36,
      height: 36,
      borderRadius: 18,
      backgroundColor: theme.text + "15",
      alignItems: "center",
      justifyContent: "center",
      marginTop: 4,
    },
    scroll: {
      flex: 1,
    },
    scrollContent: {
      paddingHorizontal: 16,
      paddingBottom: insets.bottom + 40,
      gap: 8,
    },
    card: {
      backgroundColor: theme.text + "10",
      borderRadius: 16,
      borderWidth: 1,
      borderColor: theme.text + "20",
      overflow: "hidden",
    },
    cardHeader: {
      flexDirection: "row",
      alignItems: "center",
      height: CARD_HEADER_H,
      paddingHorizontal: 16,
      gap: 12,
    },
    cardIconWrap: {
      width: 44,
      height: 44,
      borderRadius: 12,
      backgroundColor: theme.text + "10",
      alignItems: "center",
      justifyContent: "center",
    },
    cardIcon: {
      fontSize: 22,
    },
    cardTitle: {
      color: theme.text,
      fontSize: 17,
      fontWeight: "600",
    },
    cardDesc: {
      color: theme.text + "88",
      fontSize: 13,
      marginTop: 2,
      lineHeight: 17,
    },
    chevronWrap: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
    },
    countPill: {
      minWidth: 22,
      height: 22,
      paddingHorizontal: 8,
      borderRadius: 11,
      backgroundColor: theme.text + "18",
      alignItems: "center",
      justifyContent: "center",
    },
    countText: {
      color: theme.text,
      fontSize: 12,
      fontWeight: "600",
    },
    bodyContainer: {
      paddingHorizontal: 16,
      paddingVertical: BODY_PAD_V,
    },
    versionBlock: {
      alignItems: "center",
      marginTop: 24,
      paddingVertical: 16,
    },
    versionText: {
      color: theme.text + "66",
      fontSize: 13,
      fontStyle: "italic",
      textAlign: "center",
    },
    buildTagText: {
      color: theme.text + "44",
      fontSize: 11,
      marginTop: 4,
      textAlign: "center",
      fontFamily: "monospace",
    },
    runtimeText: {
      color: theme.text + "33",
      fontSize: 10,
      marginTop: 2,
      textAlign: "center",
      fontFamily: "monospace",
    },
  });
}
