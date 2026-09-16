/**
 * components/AppWelcomeIntro.tsx — Intro dell'app (v66.2, Fabio 2026-06-16).
 * -----------------------------------------------------------------------------
 * PRIMA di OllenyaIntroV3 (l'intro VOCALE), l'utente vede questa "cornice"
 * narrativa a 3 pagine. Serve a:
 *   1. Presentare l'app: cos'è (identità), non cos'è (non-terapia, non-social).
 *   2. Mettere il tono: ascolto senza giudizio, spazio proprio.
 *   3. Preparare al passo vocale (richiesta microfono, orb, parlare).
 *
 * Perché serve? Feedback utente 2026-06-16:
 * "non c'è un'introduzione vera e propria dell'app". Prima si veniva
 * catapultati direttamente nel popup nativo del microfono e nell'orb che
 * parla, senza contesto. Questa cornice risolve il "cosa sto usando?" e
 * riduce il tasso di dropout tra install e primo turno vocale.
 *
 * UX:
 *   - 3 slide con swipe orizzontale (PagerView leggero via ScrollView paged).
 *   - Dots animati in basso.
 *   - Pulsante primario "Avanti" (slide 1-2) / "Iniziamo" (slide 3).
 *   - "Salta" in alto a destra (piccolo, discreto).
 *   - onDone() → il parent smonta questo componente e mostra OllenyaIntroV3.
 *
 * NOTA: non usa network, non logga. È un semplice narrativo statico.
 */

import React, { useCallback, useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Dimensions,
  Animated,
  Platform,
  StatusBar,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";

const { width: SCREEN_W } = Dimensions.get("window");

type Slide = {
  key: string;
  emoji?: string;
  iconName?: React.ComponentProps<typeof Ionicons>["name"];
  title: string;
  body: string;
};

// Contenuto rigorosamente non-medico, non-clinico. Coerente con il tone
// del brand ("amico fraterno") — evitare "supporto psicologico", "cura",
// "guarigione" → sono termini regolamentati e alzano l'asticella legale.
const SLIDES: Slide[] = [
  {
    key: "welcome",
    iconName: "moon-outline",
    title: "Benvenuto in Ollenya",
    body:
      "Un posto tuo, per quando serve dire qualcosa e sapere che dall'altra parte c'è qualcuno che ascolta.",
  },
  {
    key: "what",
    iconName: "heart-outline",
    title: "Non è terapia, non è un social",
    body:
      "È un amico fraterno. Puoi parlare, scrivere, o solo lasciare andare quello che senti — nessuno ti giudica.",
  },
  {
    key: "start",
    iconName: "mic-outline",
    title: "Iniziamo insieme",
    body:
      "Ti chiederò il tuo nome e ti farò sentire la mia voce. Basta un momento per conoscerci.",
  },
];

export interface AppWelcomeIntroProps {
  onDone: () => void;
}

export default function AppWelcomeIntro({ onDone }: AppWelcomeIntroProps) {
  const [pageIdx, setPageIdx] = useState(0);
  const scrollRef = useRef<ScrollView | null>(null);
  const scrollX = useRef(new Animated.Value(0)).current;

  const isLast = pageIdx === SLIDES.length - 1;

  const goToPage = useCallback(
    (idx: number) => {
      const clamped = Math.max(0, Math.min(SLIDES.length - 1, idx));
      scrollRef.current?.scrollTo({ x: clamped * SCREEN_W, animated: true });
      setPageIdx(clamped);
    },
    []
  );

  const handleNext = useCallback(() => {
    if (isLast) {
      onDone();
      return;
    }
    goToPage(pageIdx + 1);
  }, [isLast, pageIdx, goToPage, onDone]);

  const handleScrollEnd = useCallback((e: any) => {
    const x = e.nativeEvent.contentOffset.x;
    const idx = Math.round(x / SCREEN_W);
    if (idx !== pageIdx) setPageIdx(idx);
  }, [pageIdx]);

  return (
    <View style={styles.root}>
      <StatusBar barStyle="light-content" backgroundColor="#0F0C1C" />
      <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
        {/* Skip in alto a destra */}
        <View style={styles.topBar}>
          <TouchableOpacity
            onPress={onDone}
            hitSlop={16}
            style={styles.skipBtn}
            testID="app-intro-skip"
            accessibilityLabel="Salta introduzione"
          >
            <Text style={styles.skipText}>Salta</Text>
          </TouchableOpacity>
        </View>

        {/* Pager */}
        <Animated.ScrollView
          ref={scrollRef}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          onMomentumScrollEnd={handleScrollEnd}
          onScroll={Animated.event(
            [{ nativeEvent: { contentOffset: { x: scrollX } } }],
            { useNativeDriver: false }
          )}
          scrollEventThrottle={16}
          style={styles.pager}
          contentContainerStyle={{ alignItems: "center" }}
        >
          {SLIDES.map((slide) => (
            <View key={slide.key} style={styles.slide}>
              <View style={styles.iconWrap}>
                {slide.iconName ? (
                  <Ionicons name={slide.iconName} size={64} color="#D4B896" />
                ) : (
                  <Text style={styles.iconEmoji}>{slide.emoji}</Text>
                )}
              </View>
              <Text style={styles.title}>{slide.title}</Text>
              <Text style={styles.body}>{slide.body}</Text>
            </View>
          ))}
        </Animated.ScrollView>

        {/* Dots */}
        <View style={styles.dotsRow}>
          {SLIDES.map((_, i) => {
            const inputRange = [
              (i - 1) * SCREEN_W,
              i * SCREEN_W,
              (i + 1) * SCREEN_W,
            ];
            const dotWidth = scrollX.interpolate({
              inputRange,
              outputRange: [8, 22, 8],
              extrapolate: "clamp",
            });
            const dotOpacity = scrollX.interpolate({
              inputRange,
              outputRange: [0.35, 1, 0.35],
              extrapolate: "clamp",
            });
            return (
              <Animated.View
                key={`dot-${i}`}
                style={[
                  styles.dot,
                  { width: dotWidth, opacity: dotOpacity },
                ]}
              />
            );
          })}
        </View>

        {/* CTA */}
        <View style={styles.ctaWrap}>
          <TouchableOpacity
            onPress={handleNext}
            style={styles.ctaBtn}
            activeOpacity={0.85}
            testID="app-intro-cta"
            accessibilityLabel={isLast ? "Iniziamo" : "Avanti"}
          >
            <Text style={styles.ctaText}>
              {isLast ? "Iniziamo" : "Avanti"}
            </Text>
            {!isLast && (
              <Ionicons
                name="chevron-forward"
                size={20}
                color="#1F1A36"
                style={{ marginLeft: 4 }}
              />
            )}
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#0F0C1C",
  },
  safe: {
    flex: 1,
  },
  topBar: {
    flexDirection: "row",
    justifyContent: "flex-end",
    paddingHorizontal: 20,
    paddingVertical: 8,
  },
  skipBtn: {
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  skipText: {
    color: "rgba(226,232,240,0.55)",
    fontSize: 15,
    fontWeight: "500",
  },
  pager: {
    flex: 1,
  },
  slide: {
    width: SCREEN_W,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 32,
    paddingVertical: 24,
  },
  iconWrap: {
    width: 128,
    height: 128,
    borderRadius: 64,
    backgroundColor: "rgba(212,184,150,0.08)",
    borderWidth: 1,
    borderColor: "rgba(212,184,150,0.20)",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 36,
  },
  iconEmoji: {
    fontSize: 56,
  },
  title: {
    color: "#F5E6CC",
    fontSize: 26,
    fontWeight: "600",
    textAlign: "center",
    marginBottom: 16,
    letterSpacing: 0.3,
  },
  body: {
    color: "rgba(226,232,240,0.80)",
    fontSize: 16,
    lineHeight: 24,
    textAlign: "center",
    maxWidth: 340,
  },
  dotsRow: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: 8,
    paddingVertical: 20,
  },
  dot: {
    height: 8,
    borderRadius: 4,
    backgroundColor: "#D4B896",
  },
  ctaWrap: {
    paddingHorizontal: 24,
    paddingBottom: Platform.OS === "ios" ? 8 : 20,
  },
  ctaBtn: {
    height: 54,
    borderRadius: 27,
    backgroundColor: "#D4B896",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
  },
  ctaText: {
    color: "#1F1A36",
    fontSize: 17,
    fontWeight: "700",
    letterSpacing: 0.3,
  },
});
