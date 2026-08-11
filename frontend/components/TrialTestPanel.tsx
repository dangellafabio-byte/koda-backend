/**
 * TrialTestPanel — Pannello di test admin-only per il paywall trial.
 *
 * Visibile solo nella sezione "🔑 Admin" delle Impostazioni (montato da
 * index.tsx). Permette di manipolare lo stato del trial dell'utente corrente
 * senza consumare 7 minuti veri di TTS (~€0.64/test).
 *
 * Progettato per essere USATO RIPETUTAMENTE nei prossimi giri (carryover,
 * RevenueCat, Opzione A timeline silenzi) — è attrezzatura di lavoro, non
 * una demo one-off.
 *
 * === Design ===
 *   - 5 pulsanti chiaramente etichettati
 *   - Ogni tap chiama l'endpoint dev-only corrispondente
 *   - Alert nativo con l'esito (stato risultante + valori raw)
 *   - Zero navigazione, tutto in-place
 *   - Palette allineata al tema, feedback visivo (opacity al press)
 *
 * === Endpoint chiamati (protetti da _require_admin() server-side) ===
 *   POST /api/dev/trial/seed-expired          → expired (budget)
 *   POST /api/dev/trial/seed-window-expired   → expired (finestra 5gg)
 *   POST /api/dev/trial/seed-closing          → closing (zona 5-7 min)
 *   POST /api/dev/trial/reset                 → active
 *   GET  /api/dev/trial/inspect               → raw state
 */
import React, { useState, useCallback } from "react";
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  Alert,
  ActivityIndicator,
} from "react-native";
import { api } from "../lib/api";
import { useTheme } from "../lib/theme";

const TAG = "KODA_TRIAL_TEST_PANEL";

type Props = {
  /** Se true renderizza il pannello. Passato da index.tsx solo quando l'utente
   * è admin — cosi il componente non deve controllare l'auth da solo. */
  visible: boolean;
};

type ButtonSpec = {
  key: string;
  label: string;
  emoji: string;
  destructive?: boolean;
  action: () => Promise<any>;
};

export default function TrialTestPanel({ visible }: Props) {
  const { theme } = useTheme();
  const [busy, setBusy] = useState<string | null>(null); // key del bottone in azione

  const runAction = useCallback(async (spec: ButtonSpec) => {
    if (busy) return; // debounce concorrente
    console.log(`[${TAG}] action=${spec.key} starting`);
    setBusy(spec.key);
    try {
      const res = await spec.action();
      const state = res?.trial_state ?? "?";
      const seconds = typeof res?.trial_seconds_used === "number"
        ? res.trial_seconds_used.toFixed(1)
        : "?";
      const startedAt = res?.trial_started_at ?? "—";
      const windowStartedAt = res?.trial_window_started_at ?? "—";
      const msg = [
        `Trial state: ${state}`,
        `Seconds used: ${seconds}`,
        `Started at: ${startedAt}`,
        `Window started: ${windowStartedAt}`,
      ].join("\n");
      Alert.alert(`✅ ${spec.emoji} ${spec.label}`, msg);
      console.log(`[${TAG}] action=${spec.key} ok state=${state}`);
    } catch (e: any) {
      const em = e?.message || String(e);
      Alert.alert(`❌ Errore: ${spec.label}`, em);
      console.warn(`[${TAG}] action=${spec.key} failed:`, em);
    } finally {
      setBusy(null);
    }
  }, [busy]);

  if (!visible) return null;

  const buttons: ButtonSpec[] = [
    {
      key: "seed-expired",
      label: "Simula EXPIRED (budget esaurito)",
      emoji: "🔴",
      destructive: true,
      action: () => api.devTrialSeedExpired(),
    },
    {
      key: "seed-window-expired",
      label: "Simula EXPIRED (finestra 5gg scaduta)",
      emoji: "⏰",
      destructive: true,
      action: () => api.devTrialSeedWindowExpired(),
    },
    {
      key: "seed-closing",
      label: "Simula CLOSING (Koda cambia tono)",
      emoji: "🟠",
      action: () => api.devTrialSeedClosing(),
    },
    {
      key: "reset",
      label: "Reset trial ad active",
      emoji: "🔄",
      action: () => api.devTrialReset(),
    },
    {
      key: "inspect",
      label: "Ispeziona stato corrente",
      emoji: "🔎",
      action: () => api.devTrialInspect(),
    },
  ];

  return (
    <View style={styles.wrap}>
      <Text style={[styles.title, { color: theme.text }]}>
        🧪 Test Trial (dev)
      </Text>
      <Text style={[styles.hint, { color: theme.textMuted }]}>
        Modifica lo stato del tuo trial per testare l'overlay expired e il
        comportamento closing di Koda senza consumare TTS reale. Solo admin.
        Modifiche persistite sul tuo profilo — usa "Reset" quando hai finito.
      </Text>
      {buttons.map((b) => {
        const isBusy = busy === b.key;
        const disabled = busy !== null && !isBusy;
        const bg = b.destructive
          ? "rgba(220, 60, 60, 0.14)"
          : "rgba(124, 107, 255, 0.14)";
        const border = b.destructive
          ? "rgba(220, 60, 60, 0.35)"
          : "rgba(124, 107, 255, 0.35)";
        return (
          <Pressable
            key={b.key}
            onPress={() => runAction(b)}
            disabled={disabled}
            style={({ pressed }) => [
              styles.btn,
              {
                backgroundColor: bg,
                borderColor: border,
                opacity: disabled ? 0.4 : pressed ? 0.7 : 1,
              },
            ]}
            accessibilityRole="button"
            accessibilityLabel={`${b.emoji} ${b.label}`}
          >
            {isBusy ? (
              <ActivityIndicator size="small" color={theme.text} />
            ) : (
              <Text style={[styles.btnText, { color: theme.text }]}>
                {b.emoji}  {b.label}
              </Text>
            )}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    marginTop: 24,
    marginBottom: 12,
  },
  title: {
    fontSize: 15,
    fontWeight: "600",
    marginBottom: 6,
    letterSpacing: 0.3,
  },
  hint: {
    fontSize: 12,
    lineHeight: 17,
    marginBottom: 14,
  },
  btn: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 16,
    marginBottom: 10,
    minHeight: 48,
    justifyContent: "center",
  },
  btnText: {
    fontSize: 14,
    fontWeight: "500",
  },
});
