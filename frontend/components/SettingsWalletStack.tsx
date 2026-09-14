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
} from "react-native";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  withSpring,
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
  /** Numero versione mostrato nel footer, es. "1.0.263". */
  version?: string;
  /** Build tag hash visibile SOLO ad admin (es. "v65.36-..."). */
  buildTag?: string;
  /** Info diagnostica runtime, visibile SOLO ad admin (es. "rt:1.0.126 · vc:25"). */
  runtimeInfo?: string;
  /** Handler tap sul numero versione (per Dev Menu 5-tap). */
  onVersionTap?: () => void;
};

const { height: SCREEN_H } = Dimensions.get("window");

// Fabio 2026-06 iter 3:
//   - Header top: usato safe-area insets (era troppo in alto vicino notch)
//   - CARD_HEADER_H ridotto da 100 → 84 così tutte le 10 card entrano
//     nello schermo senza sforare in fondo
//   - PEEK_H invariato (12 px)
// Altezza dell'header (titolo Impostazioni + subtitle + hint) fisso in cima.
const HEADER_CONTENT_H = 110;
// Altezza della "testata" visibile in vista browse per ogni card.
const CARD_HEADER_H = 84;
// Peek delle card compresse quando UNA è espansa (strip visibile).
const PEEK_H = 22;

export default function SettingsWalletStack({
  cards,
  onClose,
  title = "Impostazioni",
  subtitle = "Personalizza Ollenya come vuoi",
  hint = "Tocca una scheda per aprirla.",
  version,
  buildTag,
  runtimeInfo,
  onVersionTap,
}: Props) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(theme, insets.top, insets.bottom), [theme, insets.top, insets.bottom]);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);

  // Fabio 2026-06 iter 3: calcolo area disponibile tenendo conto di:
  //   - safe-area top (notch/Dynamic Island)
  //   - HEADER_CONTENT_H (titolo + subtitle + hint)
  //   - safe-area bottom (home indicator iOS / navbar Android)
  //   - un margine di 20 px per respiro finale
  const headerTotalH = insets.top + HEADER_CONTENT_H + 8; // 8 = paddingBottom header
  const stackHeight = SCREEN_H - headerTotalH - insets.bottom - 20;
  const n = cards.length;
  // In vista browse: step tra card. Se ne mettessi CARD_HEADER_H piene
  // sforerei; adatto lo step così TUTTE le n card stanno nell'area stack.
  const browseCardStep = Math.max(
    56,
    Math.min(CARD_HEADER_H, (stackHeight - CARD_HEADER_H) / Math.max(1, n - 1))
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

      {/* === FOOTER VERSION — sempre visibile in fondo, sopra safe-bottom.
          Tap 5 volte sulla versione = Dev Menu (per admin/whitelist).
          Utenti normali vedono solo "Ollenya v1.0.263" pulito. */}
      {version ? (
        <View style={styles.footerWrap}>
          <TouchableOpacity
            activeOpacity={1}
            onPress={onVersionTap}
            testID="settings-wallet-version-tap"
            hitSlop={{ top: 8, bottom: 8, left: 20, right: 20 }}
          >
            <Text style={styles.footerVersion}>Ollenya v{version}</Text>
          </TouchableOpacity>
          {buildTag ? (
            <Text style={styles.footerBuildTag}>{buildTag}</Text>
          ) : null}
          {runtimeInfo ? (
            <Text style={styles.footerRuntime}>{runtimeInfo}</Text>
          ) : null}
        </View>
      ) : null}
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
  // Fabio 2026-06 iter 5 — PEEK WALLET REALE:
  //   Quando UNA card è espansa, le altre restano visibili come strisce
  //   sottili (peek = 20px con solo icona compressa in orizzontale).
  //   Le card PRIMA della espansa: impilate in cima
  //     top = i * 20, height = 20
  //   Le card DOPO la espansa: impilate in fondo
  //     top = stackBottom - (n_after - k) * 20 - 20
  //   La card espansa: occupa lo spazio tra le due pile
  //   L'utente può tappare qualsiasi peek → chiude la corrente e apre quella.
  const PEEK_STRIP = PEEK_H;
  const browseTop = index * browseCardStep;

  let targetTop = browseTop;
  let targetHeight = CARD_HEADER_H + 12; // card in vista browse
  let targetOpacity = 1;
  let targetZ = index;
  let targetPointer: "auto" | "none" = "auto";
  let compactMode = false;

  if (anyExpanded) {
    if (isExpanded) {
      // Card espansa: sotto le compresse-sopra, sopra le compresse-sotto
      const topPileH = expandedIndex * PEEK_STRIP;
      const bottomCount = total - expandedIndex - 1;
      const bottomPileH = bottomCount * PEEK_STRIP;
      targetTop = topPileH + 6;
      targetHeight = stackHeight - topPileH - bottomPileH - 10;
      targetZ = 100;
      targetOpacity = 1;
    } else if (index < expandedIndex) {
      // Peek sopra la espansa: strip 22px in cima
      targetTop = index * PEEK_STRIP;
      targetHeight = PEEK_STRIP + 12; // 12px extra per tap area invisibile
      targetOpacity = 0.85;
      targetZ = index;
      compactMode = true;
    } else {
      // Peek sotto la espansa: strip 22px in fondo
      const kFromEnd = total - 1 - index; // 0 = ultima
      targetTop = stackHeight - (kFromEnd + 1) * PEEK_STRIP - 4;
      targetHeight = PEEK_STRIP + 12;
      targetOpacity = 0.85;
      targetZ = index;
      compactMode = true;
    }
  }

  // Reanimated shared values per animare
  const topSV = useSharedValue(targetTop);
  const heightSV = useSharedValue(targetHeight);
  const opacitySV = useSharedValue(targetOpacity);

  // Sync target quando cambia state
  // Fabio 2026-06 iter 3: escursione ridotta.
  //   Prima: damping 20, stiffness 160 (troppo bouncy)
  //   Ora: damping 28, stiffness 110 (molla più lenta, meno oscillazione)
  React.useEffect(() => {
    topSV.value = withSpring(targetTop, { damping: 28, stiffness: 110 });
    heightSV.value = withSpring(targetHeight, { damping: 30, stiffness: 130 });
    opacitySV.value = withTiming(targetOpacity, { duration: 260 });
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
      pointerEvents={targetPointer}
      testID={`settings-card-${card.key}`}
    >
      <View style={[styles.card, compactMode ? styles.cardCompact : null]}>
        {/* Header cliccabile — apre/chiude */}
        <TouchableOpacity
          activeOpacity={0.85}
          onPress={onHeaderPress}
          style={[styles.cardHeaderTouch, compactMode ? styles.cardHeaderCompact : null]}
        >
          {compactMode ? (
            // Peek mode: solo icona piccola + titolo inline, tutto in strip 22px
            <>
              <Text style={styles.iconEmojiCompact}>{card.icon}</Text>
              <Text style={styles.cardTitleCompact} numberOfLines={1}>
                {card.title}
              </Text>
            </>
          ) : (
            <>
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
            </>
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

function makeStyles(t: any, safeTop: number, safeBottom: number) {
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
      // Fabio 2026-06 iter 3: paddingTop dinamico via safe-area top inset.
      // Prima era hardcoded 12 → il titolo era troppo vicino al notch/status bar.
      paddingTop: safeTop + 8,
      paddingBottom: 8,
      backgroundColor: t.bg,
    },
    title: {
      color: t.text,
      fontSize: 28,
      fontWeight: "800",
      letterSpacing: -0.5,
    },
    subtitle: {
      color: t.text,
      fontSize: 14,
      fontWeight: "600",
      marginTop: 4,
      opacity: 0.85,
    },
    hint: {
      color: t.textDim,
      fontSize: 12,
      marginTop: 3,
    },
    closeBtn: {
      width: 36,
      height: 36,
      borderRadius: 18,
      backgroundColor: t.surfaceAlt,
      alignItems: "center",
      justifyContent: "center",
      marginTop: 4,
    },
    stackArea: {
      flex: 1,
      position: "relative",
      paddingHorizontal: 14,
      // Fabio 2026-06 iter 3: safe-bottom per non far sforare l'ultima card
      // sotto il home indicator iOS / gesture bar Android.
      paddingBottom: safeBottom + 4,
    },
    cardWrap: {
      position: "absolute",
      left: 14,
      right: 14,
    },
    card: {
      flex: 1,
      backgroundColor: t.surface,
      borderRadius: 20,
      borderWidth: 1,
      borderColor: t.border,
      overflow: "hidden",
      // Shadow per profondità wallet-like
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 6 },
      shadowOpacity: 0.35,
      shadowRadius: 12,
      elevation: 8,
    },
    cardHeaderTouch: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingHorizontal: 14,
      paddingVertical: 12,
      height: CARD_HEADER_H,
    },
    iconBubble: {
      width: 44,
      height: 44,
      borderRadius: 12,
      backgroundColor: t.surfaceAlt,
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 1,
      borderColor: t.border,
    },
    iconEmoji: {
      fontSize: 22,
      lineHeight: 26,
    },
    cardTitle: {
      color: t.text,
      fontSize: 17,
      fontWeight: "800",
      letterSpacing: -0.3,
    },
    cardDescription: {
      color: t.textDim,
      fontSize: 12,
      lineHeight: 15,
      marginTop: 2,
    },
    countBadge: {
      backgroundColor: t.surfaceAlt,
      borderRadius: 999,
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderWidth: 1,
      borderColor: t.border,
      minWidth: 24,
      alignItems: "center",
    },
    countText: {
      color: t.textDim,
      fontSize: 11,
      fontWeight: "700",
    },
    cardBody: {
      flex: 1,
      paddingHorizontal: 16,
    },
    // === PEEK MODE (Fabio 2026-06 iter 5) ================================
    // Strip 22px con solo icona compressa + titolo inline. Serve a mostrare
    // le card sopra/sotto quando una è espansa, come nel Wallet iPhone.
    cardCompact: {
      borderRadius: 14,
    },
    cardHeaderCompact: {
      height: PEEK_H + 12, // 22 + 12 padding
      paddingVertical: 4,
      paddingHorizontal: 12,
      gap: 8,
    },
    iconEmojiCompact: {
      fontSize: 14,
      lineHeight: 18,
    },
    cardTitleCompact: {
      color: t.text,
      fontSize: 13,
      fontWeight: "700",
      flex: 1,
    },
    // === FOOTER VERSION ==================================================
    // Ripristinato 2026-06 (Fabio): senza questo l'utente admin non ha piu'
    // accesso al Dev Menu (5-tap sulla version footer).
    footerWrap: {
      paddingVertical: 10,
      alignItems: "center",
      backgroundColor: t.bg,
    },
    footerVersion: {
      color: t.textDim,
      fontSize: 11,
      fontStyle: "italic",
      opacity: 0.7,
    },
    footerBuildTag: {
      color: t.textDim,
      fontSize: 9,
      letterSpacing: 0.5,
      marginTop: 3,
      opacity: 0.4,
    },
    footerRuntime: {
      color: t.textDim,
      fontSize: 8,
      letterSpacing: 0.3,
      marginTop: 2,
      opacity: 0.3,
    },
  });
}
