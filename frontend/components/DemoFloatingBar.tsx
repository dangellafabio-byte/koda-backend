/**
 * DemoFloatingBar — barra flottante persistente durante Test Suite
 * ================================================================
 *
 * Renderizzata in _layout.tsx sopra tutte le schermate. Legge lo stato
 * demo da SecureStore (poll ogni 1.5s) e mostra:
 *   - ID del test in corso + risultato atteso in breve
 *   - Bottone "✓ PASS / torna alla suite" e "✗ FAIL / torna alla suite"
 *
 * Zero interazione richiesta se l'utente non vuole. È solo un aiuto
 * per non doversi ricordare cosa aspettarsi mentre l'app è su una
 * schermata target (Intro V3, Intro Premium, paywall, lascia-andare).
 */
import React, { useEffect, useState, useRef } from "react";
import { View, Text, Pressable, StyleSheet, Platform } from "react-native";
import * as SecureStore from "expo-secure-store";
import { useRouter, usePathname } from "expo-router";

const DEMO_MODE_KEY = "koda_demo_mode";
const DEMO_TEST_ID_KEY = "koda_demo_test_id";
const DEMO_TEST_STATUS_KEY = "koda_demo_test_status";
const POLL_MS = 1500;

const EXPECTATIONS: Record<string, { short: string; targetHint: string }> = {
  "1": {
    short: "Devi vedere Intro Premium (coach-mark, voce Cielo).",
    targetHint: "Attesa route: /intro-premium",
  },
  "2": {
    short: "Sul paywall: bottone '[DEV] Simula pagamento' visibile? Sì → PASS. Tap → Intro Premium.",
    targetHint: "Attesa route: /paywall → /intro-premium",
  },
  "3": {
    short: "Devi vedere Intro V3 (sequenza narrativa, voce Cielo).",
    targetHint: "Attesa route: /intro-v3",
  },
  "4": {
    short: "L'app si sta gestendo da sola. Osserva ~8s: deve finire su /lascia-andare.",
    targetHint: "Attesa route: /lascia-andare",
  },
  "5": {
    short: "Con aereo attivo: NIENTE flash V3. Poi disattiva aereo → deve apparire Intro Premium.",
    targetHint: "Attesa route: /intro-premium (dopo riattivazione rete)",
  },
};

export default function DemoFloatingBar() {
  const router = useRouter();
  const pathname = usePathname();
  const [active, setActive] = useState(false);
  const [testId, setTestId] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    let timer: ReturnType<typeof setInterval> | null = null;

    const poll = async () => {
      try {
        const mode = await SecureStore.getItemAsync(DEMO_MODE_KEY);
        const tid = await SecureStore.getItemAsync(DEMO_TEST_ID_KEY);
        if (!mountedRef.current) return;
        setActive(mode === "1");
        setTestId(tid);
      } catch {
        // web / no securestore: silent
      }
    };

    poll();
    timer = setInterval(poll, POLL_MS);
    return () => {
      mountedRef.current = false;
      if (timer) clearInterval(timer);
    };
  }, []);

  // Non mostrare la barra QUANDO siamo GIÀ sulla dev-router-demo screen
  // (evita doppia UI).
  if (!active) return null;
  if (pathname === "/dev-router-demo") return null;

  const exp = testId ? EXPECTATIONS[testId] : null;

  const markAndReturn = async (status: "pass" | "fail") => {
    try {
      await SecureStore.setItemAsync(DEMO_TEST_STATUS_KEY, status);
    } catch {}
    router.push("/dev-router-demo");
  };

  return (
    <View style={styles.wrap} pointerEvents="box-none">
      <View style={styles.bar}>
        <View style={styles.headerRow}>
          <Text style={styles.badge}>TEST {testId || "?"}</Text>
          <Text style={styles.pathHint}>@ {pathname || "?"}</Text>
        </View>
        {exp && (
          <>
            <Text style={styles.expected}>{exp.short}</Text>
            <Text style={styles.target}>{exp.targetHint}</Text>
          </>
        )}
        <View style={styles.btnRow}>
          <Pressable
            onPress={() => markAndReturn("pass")}
            style={[styles.btn, styles.btnPass]}
            hitSlop={8}
            testID="demo-mark-pass"
          >
            <Text style={styles.btnPassText}>✓ PASS · torna alla suite</Text>
          </Pressable>
          <Pressable
            onPress={() => markAndReturn("fail")}
            style={[styles.btn, styles.btnFail]}
            hitSlop={8}
            testID="demo-mark-fail"
          >
            <Text style={styles.btnFailText}>✗ FAIL</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 9999,
    elevation: 9999,
    paddingHorizontal: 12,
    paddingBottom: Platform.select({ ios: 30, android: 20, default: 16 }),
  },
  bar: {
    backgroundColor: "rgba(0, 0, 0, 0.92)",
    borderWidth: 1,
    borderColor: "rgba(0, 245, 212, 0.5)",
    borderRadius: 14,
    padding: 12,
    gap: 6,
    shadowColor: "#00F5D4",
    shadowOpacity: 0.25,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 2 },
  },
  headerRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  badge: {
    color: "#00F5D4",
    fontWeight: "800",
    fontSize: 11,
    letterSpacing: 0.5,
    borderWidth: 1,
    borderColor: "rgba(0, 245, 212, 0.5)",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  pathHint: { color: "rgba(255,255,255,0.5)", fontSize: 11, flex: 1 },
  expected: { color: "#FFFFFF", fontSize: 12.5, lineHeight: 17, marginTop: 2 },
  target: { color: "rgba(0, 245, 212, 0.85)", fontSize: 10.5, fontStyle: "italic" },
  btnRow: { flexDirection: "row", gap: 8, marginTop: 6 },
  btn: {
    paddingVertical: 9,
    paddingHorizontal: 10,
    borderRadius: 8,
    borderWidth: 1,
  },
  btnPass: {
    flex: 1,
    backgroundColor: "rgba(0, 245, 212, 0.15)",
    borderColor: "rgba(0, 245, 212, 0.6)",
  },
  btnPassText: {
    color: "#00F5D4",
    fontSize: 12,
    fontWeight: "700",
    textAlign: "center",
  },
  btnFail: {
    backgroundColor: "rgba(255, 90, 90, 0.15)",
    borderColor: "rgba(255, 90, 90, 0.6)",
  },
  btnFailText: {
    color: "#FF5A5A",
    fontSize: 12,
    fontWeight: "700",
    textAlign: "center",
  },
});
