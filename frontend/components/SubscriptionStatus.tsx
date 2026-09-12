/**
 * SubscriptionStatus.tsx — Piano attivo + barra consumo minuti (Fabio 2026-06)
 *
 * Mostrato all'inizio della modal Impostazioni. Renderizzato SOLO se
 * l'utente ha un `subscription_tier` paid (monthly/bimonthly/annual/unlimited).
 * Se Free/None: componente restituisce null (nessuna sezione mostrata).
 *
 * Cosa mostra:
 *   1. Nome piano leggibile ("Mensile" / "Bimestrale" / "Annuale" / "Illimitato")
 *   2. Data prossimo rinnovo (dal ledger_state.current_period_end)
 *   3. Barra visiva a segmenti:
 *      [========== base rimanente (verde) ========|=== carryover (azzurro) ===|== top-up (viola) ==|=== usati (grigio) ===]
 *   4. Riga testuale sotto: "350 di 500 min disponibili · 50 min carryover · 30 min top-up"
 *   5. Un separatore prima delle altre sezioni Impostazioni.
 *
 * NB: se `ledger_state` è null (utente unlimited o admin senza ledger),
 * mostriamo solo il pill "Piano attivo: Illimitato" senza barra.
 *
 * Il calcolo dei numeri è lato client: leggiamo direttamente
 * profile.ledger_state (dataclass serializzato dal backend). Se un giorno
 * i dati diventeranno più complessi, si può muovere il calcolo in un
 * endpoint /api/subscription/status.
 */
import React from "react";
import { View, Text, StyleSheet } from "react-native";

// Tipi minimi per non introdurre dipendenze incrociate
type CarryoverSlot = {
  origin_month_index: number;
  minutes_remaining: number;
  expires_at_iso: string;  // FIX 2026-06: field name allineato al backend dataclass (subscription_ledger.py:CarryoverSlot.expires_at_iso)
};

type LedgerState = {
  plan: "monthly" | "bimonthly" | "annual";
  current_period_index: number;
  // FIX 2026-06 — nomi campo devono avere suffisso `_iso` per matchare il
  // dataclass Python `SubscriptionLedger` serializzato via `to_dict()`.
  // Prima leggevo `current_period_end` (senza _iso) → sempre undefined
  // → UI mostrava "Prossimo rinnovo minuti: —" (bug segnalato da Fabio).
  current_period_end_iso: string;
  current_period_start_iso?: string;
  base_minutes_used: number;
  carryover_slots: CarryoverSlot[];
  topup_minutes_remaining?: number;
};

type Profile = {
  subscription_tier?: string | null;
  ledger_state?: LedgerState | null;
};

// Base minuti per ogni tier — deve essere allineato al backend
// subscription_ledger.py:TIER_BASE_MINUTES. Se cambi lì, cambia qui.
const TIER_BASE_MINUTES: Record<string, number> = {
  monthly: 500,
  bimonthly: 500,
  annual: 500,
};

const PLAN_LABEL: Record<string, string> = {
  monthly: "Mensile",
  bimonthly: "Bimestrale",
  annual: "Annuale",
  unlimited: "Illimitato",
};

// Palette (indipendente dal theme: colori a contrasto stabile in dark+light,
// coerenti col paywall). Se serve integrare col theme, sostituire con
// props e passare colori dall'esterno.
const COLORS = {
  base: "#7A5CFF",       // primary — minuti base del mese
  carryover: "#4FC3F7",  // azzurro — carryover slot
  topup: "#B39DDB",      // viola chiaro — top-up
  consumed: "#3A3A44",   // grigio — consumati
  border: "#2A2A34",
  text: "#F0F0F5",
  textDim: "#9A9AA5",
};

function formatDate(iso: string | undefined): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("it-IT", { day: "2-digit", month: "short", year: "numeric" });
  } catch {
    return "—";
  }
}

export default function SubscriptionStatus({ profile }: { profile: Profile | null | undefined }) {
  const tier = profile?.subscription_tier || null;
  const isPaid =
    tier === "monthly" || tier === "bimonthly" || tier === "annual" || tier === "unlimited";
  if (!isPaid) return null;

  // Unlimited: mostra solo pill, senza barra
  if (tier === "unlimited") {
    return (
      <View style={styles.card}>
        <View style={styles.headerRow}>
          <Text style={styles.planLabel}>Piano attivo</Text>
          <Text style={styles.planName}>Illimitato</Text>
        </View>
        <Text style={styles.hint}>
          Minuti voce senza limite. Chat scritta sempre illimitata.
        </Text>
      </View>
    );
  }

  const ls = profile?.ledger_state;
  const plan = ls?.plan || (tier as "monthly" | "bimonthly" | "annual");
  const baseMax = TIER_BASE_MINUTES[plan] || 500;
  const baseUsed = Math.max(0, Math.min(baseMax, ls?.base_minutes_used || 0));
  const baseRem = Math.max(0, baseMax - baseUsed);
  const carryover = Math.max(
    0,
    (ls?.carryover_slots || []).reduce((acc, s) => acc + (s.minutes_remaining || 0), 0)
  );
  const topup = Math.max(0, ls?.topup_minutes_remaining || 0);
  const totalRemaining = baseRem + carryover + topup;
  const totalCapacity = baseMax + carryover + topup;

  // Larghezze proporzionali dei 4 segmenti (in %). Se totalCapacity=0
  // renderizziamo una barra vuota grigia.
  const pctBase = totalCapacity > 0 ? (baseRem / totalCapacity) * 100 : 0;
  const pctCarry = totalCapacity > 0 ? (carryover / totalCapacity) * 100 : 0;
  const pctTop = totalCapacity > 0 ? (topup / totalCapacity) * 100 : 0;
  const pctUsed = totalCapacity > 0 ? (baseUsed / totalCapacity) * 100 : 100;

  return (
    <View style={styles.card}>
      <View style={styles.headerRow}>
        <Text style={styles.planLabel}>Piano attivo</Text>
        <Text style={styles.planName}>{PLAN_LABEL[plan] || plan}</Text>
      </View>
      <Text style={styles.renewalLine}>
        Prossimo rinnovo minuti: {formatDate(ls?.current_period_end_iso)}
      </Text>

      {/* Barra a segmenti proporzionali. Layout: base (verde) + carryover
          (azzurro) + topup (viola) + consumati (grigio). */}
      <View style={styles.bar}>
        {pctBase > 0 && <View style={[styles.barSeg, { width: `${pctBase}%`, backgroundColor: COLORS.base }]} />}
        {pctCarry > 0 && <View style={[styles.barSeg, { width: `${pctCarry}%`, backgroundColor: COLORS.carryover }]} />}
        {pctTop > 0 && <View style={[styles.barSeg, { width: `${pctTop}%`, backgroundColor: COLORS.topup }]} />}
        {pctUsed > 0 && <View style={[styles.barSeg, { width: `${pctUsed}%`, backgroundColor: COLORS.consumed }]} />}
      </View>

      {/* Legenda numerica */}
      <View style={styles.legendRow}>
        <View style={styles.legendItem}>
          <View style={[styles.dot, { backgroundColor: COLORS.base }]} />
          <Text style={styles.legendText}>{Math.round(baseRem)} min base</Text>
        </View>
        {carryover > 0 && (
          <View style={styles.legendItem}>
            <View style={[styles.dot, { backgroundColor: COLORS.carryover }]} />
            <Text style={styles.legendText}>{Math.round(carryover)} carryover</Text>
          </View>
        )}
        {topup > 0 && (
          <View style={styles.legendItem}>
            <View style={[styles.dot, { backgroundColor: COLORS.topup }]} />
            <Text style={styles.legendText}>{Math.round(topup)} top-up</Text>
          </View>
        )}
      </View>

      <Text style={styles.totalLine}>
        {Math.round(totalRemaining)} min disponibili · {Math.round(baseUsed)} usati questo mese
      </Text>
      <Text style={styles.textNote}>
        La chat scritta con Koda è sempre disponibile, anche senza minuti voce.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginTop: 4,
    marginBottom: 16,
    paddingVertical: 14,
    paddingHorizontal: 14,
    backgroundColor: "rgba(122, 92, 255, 0.06)",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 4,
  },
  planLabel: {
    color: COLORS.textDim,
    fontSize: 12,
    fontWeight: "500",
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  planName: {
    color: COLORS.text,
    fontSize: 16,
    fontWeight: "700",
  },
  renewalLine: {
    color: COLORS.textDim,
    fontSize: 11.5,
    marginBottom: 12,
  },
  bar: {
    flexDirection: "row",
    height: 10,
    borderRadius: 5,
    overflow: "hidden",
    backgroundColor: COLORS.consumed,
    marginBottom: 10,
  },
  barSeg: {
    height: "100%",
  },
  legendRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12,
    marginBottom: 6,
  },
  legendItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  legendText: {
    color: COLORS.textDim,
    fontSize: 11.5,
  },
  totalLine: {
    color: COLORS.text,
    fontSize: 13,
    fontWeight: "600",
    marginTop: 4,
  },
  textNote: {
    color: COLORS.textDim,
    fontSize: 11,
    fontStyle: "italic",
    marginTop: 6,
  },
  hint: {
    color: COLORS.textDim,
    fontSize: 12,
    marginTop: 4,
  },
});
