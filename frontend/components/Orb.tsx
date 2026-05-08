/**
 * Orb — La presenza visiva centrale di Taccuino Vivo.
 *
 * Non è un avatar. Non è un pulsante. È **Coda**: un piccolo nucleo di luce
 * che respira a riposo, pulsa con la voce dell'utente quando ascolta, e
 * diventa fonte luminosa quando parla. Trasforma l'app da "chat" a "presenza".
 *
 * Stati:
 *  - idle       → respiro lento (3s ciclo), aurora soft
 *  - recording  → outer halo segue il dB della voce (instant feedback)
 *  - thinking   → shimmer rotante + pulse leggero (l'AI sta riflettendo)
 *  - speaking   → pulsazione ritmica calda (Coda parla)
 *
 * Performance: usa solo Animated nativo + LinearGradient. Niente SVG, niente
 * deps extra. Tutte le animazioni gestite con useNativeDriver dove possibile.
 */
import React, { useEffect, useRef, useMemo } from "react";
import { View, StyleSheet, Animated, Easing, Image } from "react-native";
import { LinearGradient } from "expo-linear-gradient";

export type OrbStatus = "idle" | "recording" | "thinking" | "speaking";
export type OrbTone =
  | "neutral"
  | "calm"
  | "warm"
  | "energetic"
  | "concerned"
  | "urgent";

type OrbProps = {
  status: OrbStatus;
  /** Live mic dB value during recording (typically -160..0). Maps to outer halo scale. */
  meterDb?: number | null;
  /** Optional dynamic voice-presence threshold, used to normalize meter to 0..1. */
  meterThreshold?: number | null;
  /** Tone of the current AI reply (only matters when speaking). */
  tone?: OrbTone | null;
  /** Total square size in pixels. Default 220. */
  size?: number;
  /** Optional user-uploaded avatar shown inside the core (replaces gradient core). */
  avatarUri?: string | null;
  /**
   * Custom palette [outer, mid, core] that overrides the tone palette.
   * Used for time-of-day ambient tinting from useOrbAmbient.
   */
  palette?: [string, string, string] | null;
  /**
   * Warmth (0..1): how brightly Coda shines based on recent interactions.
   * Boosts halo opacity & size. From useOrbAmbient.
   */
  warmth?: number;
  /**
   * Dim (0..1): reduces global Orb opacity when the user has been silent
   * for a long time — Coda is "waiting", not absent. From useOrbAmbient.
   */
  dim?: number;
  /**
   * Live scroll offset of the timeline (delta in px since last render).
   * The Orb peeks slightly toward the direction of scroll. ±60 typical.
   */
  scrollPeek?: number;
  /**
   * If true, enable the gentle organic drift on X/Y axes (the Orb feels
   * slightly alive even when nothing happens). Default true.
   */
  drift?: boolean;
};

// === Color palettes per tone (used when speaking; idle uses warm by default) ===
const TONE_COLORS: Record<OrbTone, [string, string, string]> = {
  // [outer halo, mid ring, core]
  neutral: ["#A78BFA", "#8B5CF6", "#7C3AED"],
  calm: ["#60A5FA", "#38BDF8", "#0EA5E9"],
  warm: ["#FCD34D", "#FBBF24", "#F59E0B"],
  energetic: ["#86EFAC", "#34D399", "#10B981"],
  concerned: ["#FDBA74", "#FB923C", "#F97316"],
  urgent: ["#FCA5A5", "#F87171", "#EF4444"],
};

const DEFAULT_COLORS = TONE_COLORS.warm;

export default function Orb({
  status,
  meterDb,
  meterThreshold,
  tone,
  size = 220,
  avatarUri,
  palette: customPalette,
  warmth = 0,
  dim = 0,
  scrollPeek = 0,
  drift = true,
}: OrbProps) {
  // Three independent breathing values, slightly offset → richer organic feel
  const breath1 = useRef(new Animated.Value(0)).current; // outer halo
  const breath2 = useRef(new Animated.Value(0.3)).current; // mid ring
  const breath3 = useRef(new Animated.Value(0.6)).current; // core highlight
  // Shimmer rotation (used when thinking)
  const spin = useRef(new Animated.Value(0)).current;
  // Live meter (recording): smoothed amplitude 0..1
  const meterAmp = useRef(new Animated.Value(0)).current;
  // Speaking pulse intensity
  const speakPulse = useRef(new Animated.Value(0)).current;
  // Organic drift on X/Y axes — random walk around the centre
  const driftX = useRef(new Animated.Value(0)).current;
  const driftY = useRef(new Animated.Value(0)).current;
  // Smooth scroll-peek tilt (the Orb leans slightly toward the scroll direction)
  const peek = useRef(new Animated.Value(0)).current;
  // Smooth warmth value (avoid jitter when timeline updates)
  const warmthAnim = useRef(new Animated.Value(0)).current;
  // Smooth dim value
  const dimAnim = useRef(new Animated.Value(0)).current;

  // === Always-on: gentle breathing (3s cycle, three offset waves) ===
  useEffect(() => {
    const loop = (val: Animated.Value, duration: number) =>
      Animated.loop(
        Animated.sequence([
          Animated.timing(val, {
            toValue: 1,
            duration,
            easing: Easing.inOut(Easing.sin),
            useNativeDriver: true,
          }),
          Animated.timing(val, {
            toValue: 0,
            duration,
            easing: Easing.inOut(Easing.sin),
            useNativeDriver: true,
          }),
        ])
      );
    const a = loop(breath1, 2400);
    const b = loop(breath2, 2800);
    const c = loop(breath3, 2000);
    a.start();
    b.start();
    c.start();
    return () => {
      a.stop();
      b.stop();
      c.stop();
    };
  }, [breath1, breath2, breath3]);

  // === Thinking: shimmer rotation ===
  useEffect(() => {
    if (status !== "thinking") return;
    const anim = Animated.loop(
      Animated.timing(spin, {
        toValue: 1,
        duration: 2200,
        easing: Easing.linear,
        useNativeDriver: true,
      })
    );
    anim.start();
    return () => {
      anim.stop();
      spin.setValue(0);
    };
  }, [status, spin]);

  // === Speaking: rhythmic pulse ===
  useEffect(() => {
    if (status !== "speaking") {
      Animated.timing(speakPulse, {
        toValue: 0,
        duration: 400,
        useNativeDriver: true,
      }).start();
      return;
    }
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(speakPulse, {
          toValue: 1,
          duration: 380,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(speakPulse, {
          toValue: 0,
          duration: 520,
          easing: Easing.in(Easing.quad),
          useNativeDriver: true,
        }),
      ])
    );
    anim.start();
    return () => {
      anim.stop();
    };
  }, [status, speakPulse]);

  // === Recording: live mic amplitude → smooth amp (0..1) ===
  useEffect(() => {
    if (status !== "recording") {
      // Smoothly fade meter back to 0 when not recording
      Animated.timing(meterAmp, {
        toValue: 0,
        duration: 250,
        useNativeDriver: true,
      }).start();
      return;
    }
    if (meterDb == null) return;
    // Map dB to 0..1: floor (~ threshold or -55) → 0, peak (~ -10dB) → 1
    const floor =
      meterThreshold != null && meterThreshold > -60
        ? meterThreshold
        : -55;
    const ceiling = -10;
    const norm = Math.max(
      0,
      Math.min(1, (meterDb - floor) / (ceiling - floor))
    );
    // Soft attack + slow release for a natural pulse — not jittery
    Animated.timing(meterAmp, {
      toValue: norm,
      duration: 90,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start();
  }, [status, meterDb, meterThreshold, meterAmp]);

  // === Organic drift — random walk on X/Y so the Orb feels alive even at idle.
  // Each leg picks a fresh random target within [-driftAmount, +driftAmount]
  // and easings to it over 4-7 seconds; loops indefinitely.
  useEffect(() => {
    if (!drift) return;
    const driftAmount = size * 0.06; // gentle: ±6% of orb size
    let stop = false;
    const step = (val: Animated.Value) => {
      if (stop) return;
      const target = (Math.random() * 2 - 1) * driftAmount;
      const dur = 4000 + Math.random() * 3000;
      Animated.timing(val, {
        toValue: target,
        duration: dur,
        easing: Easing.inOut(Easing.sin),
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished) step(val);
      });
    };
    step(driftX);
    // Phase-offset Y so the motion isn't a perfect line
    setTimeout(() => step(driftY), 1700);
    return () => {
      stop = true;
    };
  }, [drift, size, driftX, driftY]);

  // === Scroll-peek — Orb leans slightly toward the scroll direction ===
  useEffect(() => {
    // scrollPeek is provided by parent as a (small) numeric offset. We clamp
    // and smoothly animate towards it so quick scroll bursts don't jolt.
    const target = Math.max(-1, Math.min(1, scrollPeek / 80));
    Animated.timing(peek, {
      toValue: target,
      duration: 220,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start();
  }, [scrollPeek, peek]);

  // === Smooth warmth / dim transitions ===
  useEffect(() => {
    Animated.timing(warmthAnim, {
      toValue: warmth,
      duration: 800,
      useNativeDriver: true,
    }).start();
  }, [warmth, warmthAnim]);
  useEffect(() => {
    Animated.timing(dimAnim, {
      toValue: dim,
      duration: 1200,
      useNativeDriver: true,
    }).start();
  }, [dim, dimAnim]);

  // === Color selection ===
  const colors: [string, string, string] = useMemo(() => {
    // Speaking state always wins — must reflect the AI's emotional tone
    if (status === "speaking" && tone && TONE_COLORS[tone]) {
      return TONE_COLORS[tone];
    }
    // Otherwise, use the time-of-day palette if provided
    if (customPalette) return customPalette;
    return DEFAULT_COLORS;
  }, [status, tone, customPalette]);

  // === Derived animated styles ===
  // Outer halo: combines breathing + (mic amplitude when recording) + (speak pulse when speaking) + warmth
  const haloScale = Animated.add(
    Animated.add(
      Animated.add(
        breath1.interpolate({ inputRange: [0, 1], outputRange: [1.0, 1.06] }),
        meterAmp.interpolate({ inputRange: [0, 1], outputRange: [0, 0.22] })
      ),
      speakPulse.interpolate({ inputRange: [0, 1], outputRange: [0, 0.14] })
    ),
    warmthAnim.interpolate({ inputRange: [0, 1], outputRange: [0, 0.08] })
  );
  const haloOpacity = Animated.add(
    Animated.add(
      breath1.interpolate({ inputRange: [0, 1], outputRange: [0.3, 0.5] }),
      Animated.add(
        meterAmp.interpolate({ inputRange: [0, 1], outputRange: [0, 0.35] }),
        speakPulse.interpolate({ inputRange: [0, 1], outputRange: [0, 0.25] })
      )
    ),
    warmthAnim.interpolate({ inputRange: [0, 1], outputRange: [0, 0.2] })
  );

  const midScale = Animated.add(
    breath2.interpolate({ inputRange: [0, 1], outputRange: [0.95, 1.03] }),
    speakPulse.interpolate({ inputRange: [0, 1], outputRange: [0, 0.08] })
  );
  const midOpacity = breath2.interpolate({
    inputRange: [0, 1],
    outputRange: [0.5, 0.75],
  });

  const coreScale = Animated.add(
    breath3.interpolate({ inputRange: [0, 1], outputRange: [0.92, 1.0] }),
    Animated.add(
      meterAmp.interpolate({ inputRange: [0, 1], outputRange: [0, 0.05] }),
      speakPulse.interpolate({ inputRange: [0, 1], outputRange: [0, 0.06] })
    )
  );

  const spinDeg = spin.interpolate({
    inputRange: [0, 1],
    outputRange: ["0deg", "360deg"],
  });

  // Sizes
  const haloSize = size;
  const midSize = size * 0.72;
  const coreSize = size * 0.46;
  const shimmerSize = size * 0.92;

  // Container-level transform: drift (random walk) + scroll-peek (lean toward scroll)
  const containerTranslateX = Animated.add(
    driftX,
    peek.interpolate({ inputRange: [-1, 1], outputRange: [-size * 0.04, size * 0.04] })
  );
  const containerTranslateY = Animated.add(
    driftY,
    peek.interpolate({ inputRange: [-1, 1], outputRange: [size * 0.02, -size * 0.02] })
  );
  // Container opacity: 1 - dim. dim=0.7 → opacity 0.3 (very faded but not gone)
  const containerOpacity = dimAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 0.25],
  });

  return (
    <Animated.View
      style={[
        styles.container,
        {
          width: size,
          height: size,
          opacity: containerOpacity,
          transform: [
            { translateX: containerTranslateX },
            { translateY: containerTranslateY },
          ],
          pointerEvents: "none",
        },
      ]}
    >
      {/* Outer halo — soft glow that breathes & reacts to voice */}
      <Animated.View
        style={[
          styles.layer,
          {
            width: haloSize,
            height: haloSize,
            borderRadius: haloSize / 2,
            opacity: haloOpacity,
            transform: [{ scale: haloScale }],
          },
        ]}
      >
        <LinearGradient
          colors={[
            `${colors[0]}66`,
            `${colors[0]}22`,
            "transparent",
          ]}
          style={[styles.gradientFill, { borderRadius: haloSize / 2 }]}
          start={{ x: 0.5, y: 0.5 }}
          end={{ x: 1, y: 1 }}
        />
      </Animated.View>

      {/* Thinking shimmer — rotating arc visible only when status === 'thinking' */}
      {status === "thinking" && (
        <Animated.View
          style={[
            styles.layer,
            {
              width: shimmerSize,
              height: shimmerSize,
              borderRadius: shimmerSize / 2,
              transform: [{ rotate: spinDeg }],
              opacity: 0.55,
            },
          ]}
        >
          <LinearGradient
            colors={[
              "transparent",
              `${colors[1]}cc`,
              "transparent",
            ]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={[styles.gradientFill, { borderRadius: shimmerSize / 2 }]}
          />
        </Animated.View>
      )}

      {/* Mid ring — the body of Coda */}
      <Animated.View
        style={[
          styles.layer,
          {
            width: midSize,
            height: midSize,
            borderRadius: midSize / 2,
            opacity: midOpacity,
            transform: [{ scale: midScale }],
          },
        ]}
      >
        <LinearGradient
          colors={[
            `${colors[1]}aa`,
            `${colors[2]}44`,
          ]}
          style={[styles.gradientFill, { borderRadius: midSize / 2 }]}
          start={{ x: 0.2, y: 0.1 }}
          end={{ x: 0.8, y: 0.9 }}
        />
      </Animated.View>

      {/* Core — the brightest center. Replaced by avatar if user uploaded one. */}
      <Animated.View
        style={[
          styles.layer,
          {
            width: coreSize,
            height: coreSize,
            borderRadius: coreSize / 2,
            transform: [{ scale: coreScale }],
            overflow: "hidden",
          },
        ]}
      >
        {avatarUri ? (
          <Image
            source={{ uri: avatarUri }}
            style={{ width: "100%", height: "100%" }}
          />
        ) : (
          <LinearGradient
            colors={[
              "#FFFFFF",
              `${colors[0]}ee`,
              `${colors[2]}cc`,
            ]}
            style={[styles.gradientFill, { borderRadius: coreSize / 2 }]}
            start={{ x: 0.3, y: 0.2 }}
            end={{ x: 0.8, y: 0.85 }}
          />
        )}
      </Animated.View>

      {/* Tiny inner highlight — the "soul spark" */}
      <Animated.View
        style={[
          styles.layer,
          styles.spark,
          {
            width: coreSize * 0.32,
            height: coreSize * 0.32,
            borderRadius: (coreSize * 0.32) / 2,
            opacity: breath3.interpolate({
              inputRange: [0, 1],
              outputRange: [0.4, 0.85],
            }),
            transform: [
              { translateX: -coreSize * 0.1 },
              { translateY: -coreSize * 0.12 },
            ],
          },
        ]}
      />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: "center",
    justifyContent: "center",
  },
  layer: {
    position: "absolute",
    alignItems: "center",
    justifyContent: "center",
  },
  gradientFill: {
    width: "100%",
    height: "100%",
  },
  spark: {
    backgroundColor: "rgba(255,255,255,0.85)",
  },
});
