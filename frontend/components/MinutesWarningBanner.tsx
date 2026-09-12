/**
 * MinutesWarningBanner.tsx — Banner overlay minuti in esaurimento (Fabio 2026-06)
 *
 * Mostrato in cima alla Home (sotto l'header) quando il consumo minuti del
 * piano paid supera soglie critiche. NON blocca l'app, non mostra popup —
 * solo un banner tocca-per-nascondere con CTA discreto al paywall/top-up.
 *
 * Soglie:
 *   ≥85% → banner giallo "Attenzione: hai usato l'85% dei minuti di questo mese"
 *   ≥95% → banner rosso  "Restano pochi minuti — considera un top-up +30 min"
 *   ≥100% → banner viola "Minuti finiti — Koda continua in chat scritta"
 *
 * Il banner:
 *   - È persistente per sessione (dismissible via tap X, ma riappare al reload)
 *   - Ha CTA "Top-up +30 min" che apre paywall
 *   - Se testo already unlimited: menziona che chat scritta resta illimitata
 *
 * Component pure: riceve profile via props, calcola percentuale localmente.
 */
import React, { useMemo, useState } from "react";
import { View, Text, StyleSheet, Pressable } from "react-native";

type LedgerState = {
  plan: "monthly" | "bimonthly" | "annual";
  current_period_end_iso: string;  // FIX 2026-06: allineato al dataclass Python
  base_minutes_used: number;
  carryover_slots: Array<{ minutes_remaining: number }>;
  topup_minutes_remaining?: number;
};

type Profile = {
  subscription_tier?: string | null;
  ledger_state?: LedgerState | null;
};

const TIER_BASE_MINUTES: Record<string, number> = {
  monthly: 500,
  bimonthly: 500,
  annual: 500,
};

// Soglie (Fabio 2026-06). Se alzi/abbassi qua, verifica anche il backend
// paid_state ('warning' > 90%) per coerenza.
const WARN_THRESHOLD = 0.85;    // banner giallo
const CRIT_THRESHOLD = 0.95;    // banner rosso
const EXHAUSTED_THRESHOLD = 1.0; // banner viola

type Severity = "none" | "warning" | "critical" | "exhausted";

function computeSeverity(profile: Profile | null | undefined): {
  severity: Severity;
  usedPct: number;
  minutesLeft: number;
} {
  if (!profile) return { severity: "none", usedPct: 0, minutesLeft: 0 };
  const tier = profile.subscription_tier;
  const isPaidLimited =
    tier === "monthly" || tier === "bimonthly" || tier === "annual";
  if (!isPaidLimited) return { severity: "none", usedPct: 0, minutesLeft: 0 };

  const ls = profile.ledger_state;
  if (!ls) return { severity: "none", usedPct: 0, minutesLeft: 0 };

  const baseMax = TIER_BASE_MINUTES[ls.plan] || 500;
  const baseUsed = Math.max(0, Math.min(baseMax, ls.base_minutes_used || 0));
  const baseRem = Math.max(0, baseMax - baseUsed);
  const carryover = (ls.carryover_slots || []).reduce(
    (a, s) => a + (s.minutes_remaining || 0),
    0
  );
  const topup = Math.max(0, ls.topup_minutes_remaining || 0);
  const totalRem = baseRem + carryover + topup;
  const totalCap = baseMax + carryover + topup;

  // Percentuale USATA sul totale capacity (base+carry+topup). Se >= 100%
  // = tutto esaurito. Se >= 95% = quasi finito. Se >= 85% = warning.
  const usedPct = totalCap > 0 ? 1 - totalRem / totalCap : 0;

  let severity: Severity = "none";
  if (usedPct >= EXHAUSTED_THRESHOLD || totalRem <= 0.5) severity = "exhausted";
  else if (usedPct >= CRIT_THRESHOLD) severity = "critical";
  else if (usedPct >= WARN_THRESHOLD) severity = "warning";

  return { severity, usedPct, minutesLeft: totalRem };
}

const PALETTE = {
  warning: { bg: "#3E3A1E", border: "#8A7F35", text: "#F4E39A", cta: "#F4E39A" },
  critical: { bg: "#3E1E1E", border: "#8A3535", text: "#F49A9A", cta: "#F4B0B0" },
  exhausted: { bg: "#2E1E3E", border: "#5A3585", text: "#D1B5FF", cta: "#D1B5FF" },
};

export default function MinutesWarningBanner({
  profile,
  onOpenTopup,
  onDismiss,
}: {
  profile: Profile | null | undefined;
  onOpenTopup?: () => void;
  onDismiss?: () => void;
}) {
  const [dismissed, setDismissed] = useState(false);
  const { severity, minutesLeft } = useMemo(() => computeSeverity(profile), [profile]);

  if (dismissed || severity === "none") return null;

  const pal =
    severity === "exhausted"
      ? PALETTE.exhausted
      : severity === "critical"
      ? PALETTE.critical
      : PALETTE.warning;

  let title = "";
  let body = "";
  if (severity === "warning") {
    title = "Minuti in esaurimento";
    body = `Ti restano ${Math.round(minutesLeft)} minuti di voce questo mese. La chat scritta resta sempre disponibile.`;
  } else if (severity === "critical") {
    title = "Pochi minuti rimasti";
    body = `Solo ${Math.round(minutesLeft)} minuti di voce. Considera un top-up +30 min o continua in chat scritta.`;
  } else {
    title = "Minuti voce esauriti";
    body = "Koda resta a tua disposizione in chat scritta, sempre illimitata. Ricarica con +30 min quando vuoi.";
  }

  const handleDismiss = () => {
    setDismissed(true);
    onDismiss?.();
  };

  return (
    <View style={[styles.banner, { backgroundColor: pal.bg, borderColor: pal.border }]}>
      <View style={{ flex: 1 }}>
        <Text style={[styles.title, { color: pal.text }]}>{title}</Text>
        <Text style={[styles.body, { color: pal.text }]}>{body}</Text>
        {onOpenTopup && (severity === "critical" || severity === "exhausted") && (
          <Pressable
            onPress={onOpenTopup}
            style={[styles.cta, { borderColor: pal.cta }]}
            testID="minutes-warning-topup"
          >
            <Text style={[styles.ctaText, { color: pal.cta }]}>
              +30 min · 2,49 €
            </Text>
          </Pressable>
        )}
      </View>
      <Pressable
        onPress={handleDismiss}
        style={styles.close}
        hitSlop={12}
        testID="minutes-warning-dismiss"
        accessibilityLabel="Chiudi avviso"
      >
        <Text style={[styles.closeIcon, { color: pal.text }]}>×</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: "row",
    alignItems: "flex-start",
    marginHorizontal: 16,
    marginTop: 8,
    marginBottom: 4,
    paddingVertical: 10,
    paddingLeft: 14,
    paddingRight: 6,
    borderRadius: 10,
    borderWidth: 1,
  },
  title: {
    fontSize: 13,
    fontWeight: "700",
    marginBottom: 2,
  },
  body: {
    fontSize: 12,
    lineHeight: 17,
    opacity: 0.9,
  },
  cta: {
    alignSelf: "flex-start",
    marginTop: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
  },
  ctaText: {
    fontSize: 12,
    fontWeight: "600",
  },
  close: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    minWidth: 32,
    minHeight: 32,
    alignItems: "center",
    justifyContent: "center",
  },
  closeIcon: {
    fontSize: 22,
    fontWeight: "300",
    lineHeight: 24,
  },
});
