/**
 * /orb-check — Debug visivo posizione orb (Fabio 2026-08-23)
 * ============================================================
 *
 * Route PUBBLICA. Mostra UN singolo layout con orb + linea guida
 * orizzontale al centro Y = H/2 + 28. Il layout selezionato dipende
 * dal query param ?sec=<1..6>. Default = 1 (HOME riferimento).
 *
 * Sezioni:
 *   ?sec=1 → HOME Page 0 (riferimento)
 *   ?sec=2 → IntroPremium
 *   ?sec=3 → KodaIntroV3
 *   ?sec=4 → HeartVoiceReveal
 *   ?sec=5 → MicroDemoKoda
 *   ?sec=6 → LasciaAndare (orb size 260)
 */
import React from "react";
import {
  View,
  Text,
  StyleSheet,
  useWindowDimensions,
} from "react-native";
import { useLocalSearchParams } from "expo-router";
import EclipseOrb from "../components/EclipseOrb";

function GuideLine({ H }: { H: number }) {
  const centerY = H / 2 + 28;
  return (
    <>
      <View
        style={{
          position: "absolute",
          top: centerY - 1,
          left: 0,
          right: 0,
          height: 2,
          backgroundColor: "rgba(255, 60, 60, 0.85)",
          zIndex: 5,
        }}
        pointerEvents="none"
      />
      <View
        style={{
          position: "absolute",
          top: centerY - 22,
          right: 8,
          zIndex: 6,
        }}
        pointerEvents="none"
      >
        <Text
          style={{
            color: "#FF3C3C",
            fontSize: 11,
            fontWeight: "700",
            backgroundColor: "rgba(0,0,0,0.6)",
            paddingHorizontal: 6,
            paddingVertical: 2,
            borderRadius: 4,
          }}
        >
          Y = {Math.round(centerY)}
        </Text>
      </View>
    </>
  );
}

function SectionLabel({ title }: { title: string }) {
  return (
    <View
      style={{
        position: "absolute",
        top: 40,
        left: 0,
        right: 0,
        alignItems: "center",
        zIndex: 10,
      }}
      pointerEvents="none"
    >
      <Text
        style={{
          color: "#00F5D4",
          fontSize: 13,
          fontWeight: "700",
          backgroundColor: "rgba(0,0,0,0.6)",
          paddingHorizontal: 10,
          paddingVertical: 4,
          borderRadius: 6,
        }}
      >
        {title}
      </Text>
    </View>
  );
}

// ============================================================================

export default function OrbCheckScreen() {
  const { width: W, height: H } = useWindowDimensions();
  const params = useLocalSearchParams<{ sec?: string }>();
  const sec = String(params.sec || "1");
  const orbSize = Math.min(W * 0.78, 360);

  // === SEC 1: HOME Page 0 (riferimento, identico a index.tsx:5247-5321) ====
  if (sec === "1") {
    return (
      <View style={{ flex: 1, backgroundColor: "#0A0A0A" }}>
        <SectionLabel title="1) HOME Page 0 (riferimento)" />
        <View
          style={{
            width: W,
            flex: 1,
            alignItems: "center",
            justifyContent: "center",
            paddingTop: 90,
          }}
        >
          <View
            style={{
              alignItems: "center",
              justifyContent: "center",
              flex: 1,
              gap: 18,
              paddingHorizontal: 24,
            }}
          >
            <EclipseOrb size={orbSize} status="idle" tone="cool" />
            <Text
              style={{
                fontSize: 16,
                marginTop: 8,
                color: "rgba(226,232,240,0.8)",
                fontStyle: "italic",
              }}
            >
              {""}
            </Text>
          </View>
        </View>
        <GuideLine H={H} />
      </View>
    );
  }

  // === SEC 2: IntroPremium (absolute orbCY = H/2 + 28) ===
  if (sec === "2") {
    const orbCY = H / 2 + 28;
    return (
      <View style={{ flex: 1, backgroundColor: "#0A0A0A" }}>
        <SectionLabel title="2) IntroPremium (orbCY = H/2 + 28)" />
        <View
          style={{
            position: "absolute",
            left: W / 2 - orbSize / 2,
            top: orbCY - orbSize / 2,
            width: orbSize,
            height: orbSize,
          }}
        >
          <EclipseOrb size={orbSize} status="idle" tone="cool" />
        </View>
        <GuideLine H={H} />
      </View>
    );
  }

  // === SEC 3: KodaIntroV3 (flex-center paddingTop:90 + spacer 34) ===
  if (sec === "3") {
    return (
      <View style={{ flex: 1, backgroundColor: "#0A0A0A" }}>
        <SectionLabel title="3) KodaIntroV3 (flex-center + spacer 34)" />
        <View
          style={{
            flex: 1,
            alignItems: "center",
            justifyContent: "center",
            paddingTop: 90,
          }}
        >
          <View
            style={{
              alignItems: "center",
              justifyContent: "center",
              marginBottom: 0,
            }}
          >
            <EclipseOrb size={orbSize} status="idle" tone="cool" />
            <View style={{ height: 34 }} pointerEvents="none" />
          </View>
        </View>
        <GuideLine H={H} />
      </View>
    );
  }

  // === SEC 4: HeartVoiceReveal ===
  if (sec === "4") {
    return (
      <View style={{ flex: 1, backgroundColor: "#0A0A0A" }}>
        <SectionLabel title="4) HeartVoiceReveal (flex-center + spacer 34)" />
        <View
          style={{
            flex: 1,
            alignItems: "center",
            justifyContent: "center",
            paddingTop: 90,
          }}
        >
          <View style={{ alignItems: "center", justifyContent: "center" }}>
            <EclipseOrb size={orbSize} status="idle" tone="cool" />
            <View style={{ height: 34 }} pointerEvents="none" />
          </View>
        </View>
        <GuideLine H={H} />
      </View>
    );
  }

  // === SEC 5: MicroDemoKoda ===
  if (sec === "5") {
    return (
      <View style={{ flex: 1, backgroundColor: "#0A0A0A" }}>
        <SectionLabel title="5) MicroDemoKoda (flex-center + spacer 34)" />
        <View
          style={{
            flex: 1,
            alignItems: "center",
            justifyContent: "center",
            paddingTop: 90,
          }}
        >
          <View style={{ alignItems: "center", justifyContent: "center" }}>
            <EclipseOrb size={orbSize} status="idle" tone="cool" />
            <View style={{ height: 34 }} pointerEvents="none" />
          </View>
        </View>
        <GuideLine H={H} />
      </View>
    );
  }

  // === SEC 6: LasciaAndare (orb size fisso 260) ===
  const laSize = 260;
  return (
    <View style={{ flex: 1, backgroundColor: "#0A0A0A" }}>
      <SectionLabel title="6) LasciaAndare (size fisso 260 + spacer 34)" />
      <View
        style={{
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          paddingTop: 90,
        }}
      >
        <View style={{ alignItems: "center", justifyContent: "center" }}>
          <EclipseOrb size={laSize} status="idle" tone="cool" />
          <View style={{ height: 34 }} pointerEvents="none" />
        </View>
      </View>
      <GuideLine H={H} />
    </View>
  );
}

const styles = StyleSheet.create({});
