import React, { useEffect, useRef, useState, useCallback } from "react";
import { Animated, Easing, Pressable, Text, View, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { api } from "../lib/api";
import type { Palette } from "../lib/theme";

/**
 * ProactiveOffer — Decision Engine V1 (Manifesto "Utilità Fidata").
 *
 * All'apertura della schermata principale interroga UNA volta il backend
 * (`/api/decision/heartbeat`). Il backend decide UN'azione proattiva, mai
 * prescrittiva (OFFER_SPACE / OFFER_CHECKIN / OFFER_REFLECTION) oppure
 * DO_NOTHING. Se c'è un'azione, mostra una card discreta in alto con il
 * `user_reason` umano e due scelte: "Va bene" (ACCEPTED) o chiudi (DISMISSED).
 *
 * Principio "Graceful Failure by design": se l'endpoint non risponde (es.
 * backend non ancora deployato) NON si rompe nulla e non appare nulla.
 * "Presente, non invadente": la card si auto-nasconde dopo qualche secondo.
 */

const AUTO_HIDE_MS = 14000;

export default function ProactiveOffer({ theme }: { theme: Palette }) {
  const insets = useSafeAreaInsets();
  const [action, setAction] = useState<string | null>(null);
  const [reason, setReason] = useState<string>("");
  const [visible, setVisible] = useState(false);

  const translateY = useRef(new Animated.Value(-120)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const decidedOnce = useRef(false);

  const animateOut = useCallback(
    (onDone?: () => void) => {
      Animated.parallel([
        Animated.timing(translateY, {
          toValue: -120,
          duration: 280,
          easing: Easing.in(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 0,
          duration: 220,
          useNativeDriver: true,
        }),
      ]).start(() => {
        setVisible(false);
        onDone?.();
      });
    },
    [translateY, opacity]
  );

  // Heartbeat + analytics una sola volta al mount della schermata principale.
  useEffect(() => {
    if (decidedOnce.current) return;
    decidedOnce.current = true;
    let cancelled = false;
    (async () => {
      try {
        api.analyticsTrack("app_open").catch(() => {});
        const res = await api.decisionHeartbeat();
        if (cancelled) return;
        if (res && res.action && res.action !== "DO_NOTHING" && res.user_reason) {
          setAction(res.action);
          setReason(res.user_reason);
          setVisible(true);
          api
            .analyticsTrack("proactive_offer_shown", { action: res.action })
            .catch(() => {});
        }
      } catch {
        // Graceful failure: nessuna card.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Entrata + timer di auto-hide quando diventa visibile.
  useEffect(() => {
    if (!visible) return;
    Animated.parallel([
      Animated.timing(translateY, {
        toValue: 0,
        duration: 420,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(opacity, {
        toValue: 1,
        duration: 380,
        useNativeDriver: true,
      }),
    ]).start();
    hideTimer.current = setTimeout(() => animateOut(), AUTO_HIDE_MS);
    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, [visible, translateY, opacity, animateOut]);

  const sendFeedback = useCallback(
    (outcome: "ACCEPTED" | "DISMISSED") => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
      if (action) {
        api.decisionFeedback(action, outcome).catch(() => {});
        api
          .analyticsTrack("proactive_offer_feedback", { action, outcome })
          .catch(() => {});
      }
      animateOut();
    },
    [action, animateOut]
  );

  if (!visible) return null;

  return (
    <Animated.View
      testID="proactive-offer-card"
      pointerEvents="box-none"
      style={[
        styles.wrap,
        { top: insets.top + 10, opacity, transform: [{ translateY }] },
      ]}
    >
      <View
        style={[
          styles.card,
          {
            backgroundColor: theme.surface,
            borderColor: theme.primarySoftBorder || theme.border,
          },
        ]}
      >
        <View style={[styles.accent, { backgroundColor: theme.primary }]} />
        <View style={styles.body}>
          <Text
            testID="proactive-offer-text"
            style={[styles.reason, { color: theme.text }]}
          >
            {reason}
          </Text>
          <View style={styles.actions}>
            <Pressable
              testID="proactive-offer-accept"
              onPress={() => sendFeedback("ACCEPTED")}
              style={({ pressed }) => [
                styles.okBtn,
                {
                  backgroundColor: theme.primary,
                  opacity: pressed ? 0.85 : 1,
                },
              ]}
            >
              <Text style={[styles.okText, { color: theme.primaryText }]}>
                Va bene
              </Text>
            </Pressable>
          </View>
        </View>
        <Pressable
          testID="proactive-offer-dismiss"
          hitSlop={10}
          onPress={() => sendFeedback("DISMISSED")}
          style={styles.close}
        >
          <Ionicons name="close" size={18} color={theme.textMuted} />
        </Pressable>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: "absolute",
    left: 14,
    right: 14,
    zIndex: 60,
  },
  card: {
    flexDirection: "row",
    alignItems: "flex-start",
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: 14,
    paddingLeft: 0,
    paddingRight: 8,
    overflow: "hidden",
    shadowColor: "#000",
    shadowOpacity: 0.18,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
  accent: {
    width: 4,
    alignSelf: "stretch",
    borderTopLeftRadius: 18,
    borderBottomLeftRadius: 18,
  },
  body: {
    flex: 1,
    paddingLeft: 14,
  },
  reason: {
    fontSize: 14,
    lineHeight: 20,
    fontWeight: "400",
  },
  actions: {
    flexDirection: "row",
    marginTop: 12,
  },
  okBtn: {
    paddingHorizontal: 18,
    paddingVertical: 8,
    borderRadius: 999,
  },
  okText: {
    fontSize: 13,
    fontWeight: "600",
  },
  close: {
    paddingTop: 2,
    paddingHorizontal: 4,
  },
});
