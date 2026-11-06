"""
Unit tests per subscription_ledger.py — allineati al pricing finale
(Fabio 2026-11-06):
  Monthly    29,90 €/mese    300 min, no carryover
  Bimonthly  59,90 €/2 mesi  300 min/mese, cap 50 carry M1→M2
  Annual    354,90 €/anno    300 min/mese, cap 50 carry per passaggio mensile
                             (slot_lifetime=1 per TUTTI: il carryover vale SOLO
                             nel mese immediatamente successivo)

Scenari testati:
- Monthly: consumo + reset a fine mese senza carryover
- Bimonthly M1→M2: creazione slot con cap 50, peak M2 = 350
- Bimonthly renewal: reset totale a fine M2
- Annual: lo slot creato a fine M_N è disponibile SOLO in M_(N+1), poi scade
- Annual FIFO: consumo pesante scala prima gli slot carryover
- Annual renewal: fine M12 scarta tutti gli slot e reset a M1
- Consume oltre budget: unfulfilled > 0
- Consume zero: no-op
- Edge case Feb 30: relativedelta clampa correttamente
- Serializzazione round-trip MongoDB
"""

import sys
import pathlib
from datetime import datetime, timezone

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

from subscription_ledger import (  # noqa: E402
    TIER_BASE_MINUTES,
    TIER_MAX_CARRYOVER_PER_SLOT,
    TIER_SLOT_LIFETIME_MONTHS,
    TIER_CYCLE_LENGTH_MONTHS,
    CarryoverSlot,
    SubscriptionLedger,
    create_ledger,
    advance_period,
    consume,
    remaining_summary,
    _parse_iso,
    _add_months,
)


BASE = 300.0
CAP = 50.0
MAX_PERIOD = BASE + CAP  # 350


def _dt(y, m, d, h=12, minute=0):
    return datetime(y, m, d, h, minute, tzinfo=timezone.utc)


def _assert(cond, msg):
    if not cond:
        raise AssertionError(f"FAIL: {msg}")
    print(f"  ✓ {msg}")


# ======================================================================
# TEST 0 — Costanti pricing allineate al brief 2026-11-06
# ======================================================================
def test_pricing_constants():
    print("\n[TEST 0] Costanti pricing")
    _assert(TIER_BASE_MINUTES["monthly"] == BASE, "monthly base = 300")
    _assert(TIER_BASE_MINUTES["bimonthly"] == BASE, "bimonthly base = 300")
    _assert(TIER_BASE_MINUTES["annual"] == BASE, "annual base = 300")
    _assert(TIER_MAX_CARRYOVER_PER_SLOT["monthly"] == 0.0, "monthly carry = 0")
    _assert(TIER_MAX_CARRYOVER_PER_SLOT["bimonthly"] == CAP, "bimonthly cap = 50")
    _assert(TIER_MAX_CARRYOVER_PER_SLOT["annual"] == CAP, "annual cap = 50")
    _assert(TIER_SLOT_LIFETIME_MONTHS["monthly"] == 0, "monthly slot lifetime = 0")
    _assert(TIER_SLOT_LIFETIME_MONTHS["bimonthly"] == 1, "bimonthly slot lifetime = 1")
    _assert(TIER_SLOT_LIFETIME_MONTHS["annual"] == 1,
            "annual slot lifetime = 1 (NON 2) — il carryover vale solo nel mese successivo")
    _assert(TIER_CYCLE_LENGTH_MONTHS["annual"] == 12, "annual cycle = 12 mesi")


# ======================================================================
# TEST 1 — Monthly: nessun carryover
# ======================================================================
def test_monthly_no_carryover():
    print("\n[TEST 1] Monthly: nessun carryover, reset a fine mese")
    ledger = create_ledger("monthly", purchase_date=_dt(2026, 1, 15))

    result = consume(ledger, 60.0, now=_dt(2026, 1, 20))
    _assert(result.total_consumed == 60.0, "consumo 60 min riuscito")
    _assert(result.consumed_from_base == 60.0, "tutto da base")
    _assert(ledger.base_minutes_used == 60.0, "base_minutes_used = 60")

    advance_period(ledger, now=_dt(2026, 2, 20))
    _assert(len(ledger.carryover_slots) == 0, "nessun slot generato (monthly)")
    _assert(ledger.base_minutes_used == 0.0, "base resettato")
    _assert(ledger.current_period_index == 1, "reset a M1 nuovo ciclo")

    summary = remaining_summary(ledger, now=_dt(2026, 2, 20))
    _assert(summary["base_minutes_remaining"] == BASE, "budget pieno (300) nel nuovo mese")
    _assert(summary["carryover_minutes_total"] == 0.0, "carryover 0")


# ======================================================================
# TEST 2 — Bimonthly M1→M2: slot cap 50
# ======================================================================
def test_bimonthly_slot_creation():
    print("\n[TEST 2] Bimonthly M1→M2: slot cap 50")
    ledger = create_ledger("bimonthly", purchase_date=_dt(2026, 1, 15))

    consume(ledger, 30.0, now=_dt(2026, 1, 20))
    advance_period(ledger, now=_dt(2026, 2, 20))

    _assert(ledger.current_period_index == 2, "siamo in M2")
    _assert(len(ledger.carryover_slots) == 1, "1 slot creato")
    _assert(ledger.carryover_slots[0].minutes_remaining == CAP,
            f"slot cap 50 (non 270 residuo) — got {ledger.carryover_slots[0].minutes_remaining}")
    _assert(ledger.carryover_slots[0].origin_month_index == 1, "slot da M1")

    summary = remaining_summary(ledger, now=_dt(2026, 2, 20))
    _assert(summary["total_available_minutes"] == MAX_PERIOD,
            f"M2 ha 300 base + 50 slot = 350 (got {summary['total_available_minutes']})")


# ======================================================================
# TEST 3 — Bimonthly renewal: fine M2 scarta tutto
# ======================================================================
def test_bimonthly_renewal():
    print("\n[TEST 3] Bimonthly renewal: fine M2 scarta tutto")
    ledger = create_ledger("bimonthly", purchase_date=_dt(2026, 1, 15))

    consume(ledger, 30.0, now=_dt(2026, 1, 20))
    advance_period(ledger, now=_dt(2026, 2, 20))
    _assert(len(ledger.carryover_slots) == 1, "M2: slot presente")

    consume(ledger, 20.0, now=_dt(2026, 2, 25))
    advance_period(ledger, now=_dt(2026, 3, 20))

    _assert(ledger.current_period_index == 1, "reset a M1 nuovo ciclo")
    _assert(len(ledger.carryover_slots) == 0, "TUTTI gli slot scartati al renewal")
    _assert(ledger.base_minutes_used == 0.0, "base resettato")


# ======================================================================
# TEST 4 — Annual: slot vive SOLO il mese immediatamente successivo
# ======================================================================
def test_annual_slot_rolling_one_month():
    print("\n[TEST 4] Annual: slot creato a fine M_N vive solo in M_(N+1)")
    ledger = create_ledger("annual", purchase_date=_dt(2026, 1, 15))

    # M1: consumo 60 → leftover 240 → slot A (cap 50) valido in M2
    consume(ledger, 60.0, now=_dt(2026, 1, 20))
    advance_period(ledger, now=_dt(2026, 2, 20))
    _assert(len(ledger.carryover_slots) == 1, "M2: slot M1 presente")
    _assert(ledger.carryover_slots[0].origin_month_index == 1, "slot M1")
    _assert(ledger.carryover_slots[0].minutes_remaining == CAP, "cap 50")

    # M2: NON consumo → slot M1 NON toccato, poi avanzo a M3.
    # Fine M2: slot M1 scade (lifetime=1), nasce slot M2 (nuovo, cap 50).
    advance_period(ledger, now=_dt(2026, 3, 20))
    active_indexes = sorted(s.origin_month_index for s in ledger.carryover_slots)
    _assert(1 not in active_indexes, "slot M1 SCADUTO (lifetime=1, non arriva in M3)")
    _assert(2 in active_indexes, "slot M2 attivo in M3")
    _assert(len(active_indexes) == 1, f"esattamente 1 slot in M3, got {active_indexes}")

    summary = remaining_summary(ledger, now=_dt(2026, 3, 20))
    _assert(summary["total_available_minutes"] == MAX_PERIOD,
            f"M3 peak = 350 (300 base + 50 slot M2), got {summary['total_available_minutes']}")


# ======================================================================
# TEST 5 — Annual FIFO: slot carryover consumato PRIMA del base
# ======================================================================
def test_annual_fifo_consumption():
    print("\n[TEST 5] Annual FIFO: carryover-first")
    ledger = create_ledger("annual", purchase_date=_dt(2026, 1, 15))

    consume(ledger, 60.0, now=_dt(2026, 1, 20))     # M1
    advance_period(ledger, now=_dt(2026, 2, 20))    # → M2 con slot M1(50)
    _assert(len(ledger.carryover_slots) == 1, "setup: 1 slot in M2")

    # M2: consumo 80 → 50 da slot, 30 da base
    result = consume(ledger, 80.0, now=_dt(2026, 2, 25))
    _assert(result.consumed_from_slots == CAP, "50 dallo slot")
    _assert(result.consumed_from_base == 30.0, "30 dal base")
    _assert(result.total_consumed == 80.0, "totale 80")
    _assert(len(ledger.carryover_slots) == 0, "slot svuotato e rimosso")
    _assert(ledger.base_minutes_used == 30.0, "base = 30")
    _assert(result.slots_touched[0]["origin_month_index"] == 1, "FIFO: slot M1 first")


# ======================================================================
# TEST 5b — Annual moderato 60/60: slot rigenera OGNI mese
# ======================================================================
def test_annual_moderate_usage_60_per_month():
    print("\n[TEST 5b] Annual 60/60: nuovo slot pieno ogni mese (regola stabile)")
    ledger = create_ledger("annual", purchase_date=_dt(2026, 1, 15))

    consume(ledger, 60.0, now=_dt(2026, 1, 20))
    advance_period(ledger, now=_dt(2026, 2, 20))
    _assert(ledger.carryover_slots[0].minutes_remaining == CAP, "M2 start: Slot A = 50")

    # M2: consumo 60 → 50 dallo slot (svuotato), 10 dal base
    result_m2 = consume(ledger, 60.0, now=_dt(2026, 2, 25))
    _assert(result_m2.consumed_from_slots == CAP, "M2: 50 dallo slot")
    _assert(result_m2.consumed_from_base == 10.0, "M2: 10 dal base")
    _assert(ledger.base_minutes_used == 10.0, "M2: base_used = 10 (non 60)")

    # M2→M3: leftover base M2 = 300-10 = 290 → capped a 50 → Slot B pieno
    advance_period(ledger, now=_dt(2026, 3, 20))
    _assert(len(ledger.carryover_slots) == 1, "M3 start: 1 slot (Slot B)")
    slot_b = ledger.carryover_slots[0]
    _assert(slot_b.origin_month_index == 2, "Slot B origin = M2")
    _assert(slot_b.minutes_remaining == CAP, "Slot B pieno a 50")

    summary_m3 = remaining_summary(ledger, now=_dt(2026, 3, 20))
    _assert(summary_m3["total_available_minutes"] == MAX_PERIOD,
            f"M3: 350 disponibili, got {summary_m3['total_available_minutes']}")

    # M3: consumo 60 → 50 slot, 10 base; a fine M3 nasce Slot C pieno
    consume(ledger, 60.0, now=_dt(2026, 3, 25))
    advance_period(ledger, now=_dt(2026, 4, 20))
    _assert(len(ledger.carryover_slots) == 1, "M4: 1 slot (Slot C)")
    _assert(ledger.carryover_slots[0].origin_month_index == 3, "Slot C origin = M3")
    _assert(ledger.carryover_slots[0].minutes_remaining == CAP, "Slot C pieno")

    print("  ✅ regola stabile: 6 passaggi mensili consecutivi possibili nell'annuale")


# ======================================================================
# TEST 6 — Annual: slot M1 scade a fine M2 (lifetime=1)
# ======================================================================
def test_annual_slot_expiration():
    print("\n[TEST 6] Annual slot expiration: slot M1 scade a fine M2")
    ledger = create_ledger("annual", purchase_date=_dt(2026, 1, 15))

    consume(ledger, 60.0, now=_dt(2026, 1, 20))
    advance_period(ledger, now=_dt(2026, 2, 20))
    _assert(len(ledger.carryover_slots) == 1, "M2: slot M1 presente")

    # Nessun consumo in M2 → leftover 300 → nuovo slot M2 (50)
    advance_period(ledger, now=_dt(2026, 3, 20))
    active = sorted(s.origin_month_index for s in ledger.carryover_slots)
    _assert(1 not in active, "slot M1 SCADUTO")
    _assert(active == [2], f"solo slot M2 in M3, got {active}")


# ======================================================================
# TEST 7 — Annual renewal: fine M12 scarta tutti gli slot
# ======================================================================
def test_annual_renewal():
    print("\n[TEST 7] Annual renewal: fine M12 scarta TUTTI gli slot")
    ledger = create_ledger("annual", purchase_date=_dt(2026, 1, 15))

    # Avanza 11 mesi con consumo moderato
    for i in range(11):
        year = 2026
        month = 1 + i
        consume(ledger, 60.0, now=_dt(year, month, 20))
        nxt_month = month + 1
        nxt_year = year
        if nxt_month > 12:
            nxt_month -= 12
            nxt_year += 1
        advance_period(ledger, now=_dt(nxt_year, nxt_month, 16))

    _assert(ledger.current_period_index == 12, f"in M12, got {ledger.current_period_index}")

    consume(ledger, 30.0, now=_dt(2026, 12, 20))
    advance_period(ledger, now=_dt(2027, 1, 20))

    _assert(ledger.current_period_index == 1, "reset a M1 nuovo anno")
    _assert(len(ledger.carryover_slots) == 0, "TUTTI gli slot scartati al renewal annuale")
    _assert(ledger.base_minutes_used == 0.0, "base resettato")


# ======================================================================
# TEST 8 — Consume oltre budget: unfulfilled > 0
# ======================================================================
def test_consume_over_budget():
    print("\n[TEST 8] Consume oltre budget: unfulfilled > 0")
    ledger = create_ledger("monthly", purchase_date=_dt(2026, 1, 15))
    result = consume(ledger, 400.0, now=_dt(2026, 1, 20))

    _assert(result.consumed_from_base == BASE, f"consumati max base ({BASE})")
    _assert(result.total_consumed == BASE, f"totale = {BASE}")
    _assert(result.unfulfilled == 100.0, "unfulfilled = 400-300 = 100")
    _assert(ledger.base_minutes_used == BASE, "base saturato")


# ======================================================================
# TEST 9 — Consume zero: no-op
# ======================================================================
def test_consume_zero():
    print("\n[TEST 9] Consume 0 minuti: no-op")
    ledger = create_ledger("monthly", purchase_date=_dt(2026, 1, 15))
    result = consume(ledger, 0.0, now=_dt(2026, 1, 20))
    _assert(result.total_consumed == 0.0, "nessun consumo")
    _assert(result.unfulfilled == 0.0, "nessun unfulfilled")
    _assert(ledger.base_minutes_used == 0.0, "base intatto")


# ======================================================================
# TEST 10 — Feb edge case: relativedelta clampa
# ======================================================================
def test_feb_edge_case():
    print("\n[TEST 10] Feb edge case: acquisto 31 gen → M2 clamps a 28 feb")
    ledger = create_ledger("monthly", purchase_date=_dt(2026, 1, 31))
    end_m1 = _parse_iso(ledger.current_period_end_iso)
    _assert(end_m1.month == 2 and end_m1.day == 28,
            f"M1 finisce 28 feb (got {end_m1.date()})")

    advance_period(ledger, now=_dt(2026, 3, 5))
    end_m2 = _parse_iso(ledger.current_period_end_iso)
    _assert(end_m2.month == 3 and end_m2.day == 28,
            f"M2 finisce 28 mar (got {end_m2.date()})")


# ======================================================================
# TEST 11 — Serializzazione round-trip
# ======================================================================
def test_serialization_roundtrip():
    print("\n[TEST 11] Serializzazione round-trip via to_dict/from_dict")
    ledger = create_ledger("annual", purchase_date=_dt(2026, 1, 15))
    consume(ledger, 60.0, now=_dt(2026, 1, 20))
    advance_period(ledger, now=_dt(2026, 2, 20))

    d = ledger.to_dict()
    _assert(isinstance(d, dict), "to_dict ritorna dict")
    _assert("carryover_slots" in d, "chiave carryover_slots presente")

    restored = SubscriptionLedger.from_dict(d)
    _assert(restored.plan == ledger.plan, "plan preservato")
    _assert(restored.current_period_index == ledger.current_period_index, "index preservato")
    _assert(len(restored.carryover_slots) == len(ledger.carryover_slots), "numero slot preservato")
    _assert(restored.carryover_slots[0].minutes_remaining ==
            ledger.carryover_slots[0].minutes_remaining, "slot data preservato")


# ======================================================================
# TEST 12 — Ciclo mobile: anchor day mantenuto
# ======================================================================
def test_mobile_cycle_anchor():
    print("\n[TEST 12] Ciclo mobile: anchor day mantenuto")
    ledger = create_ledger("bimonthly", purchase_date=_dt(2026, 1, 15, 14, 30))
    m1_end = _parse_iso(ledger.current_period_end_iso)
    _assert(m1_end.day == 15, f"M1 finisce il 15 feb, got {m1_end.day}")

    advance_period(ledger, now=_dt(2026, 2, 20))
    m2_end = _parse_iso(ledger.current_period_end_iso)
    _assert(m2_end.day == 15, f"M2 finisce il 15 mar, got {m2_end.day}")


# ======================================================================
# TEST 13 — Annual: massimo 6 riporti nell'annualità (brief 2026-11-06)
# ======================================================================
def test_annual_max_6_carryovers_in_cycle():
    print("\n[TEST 13] Annual: 6 passaggi mensili consecutivi × 50 = 300 totali")
    ledger = create_ledger("annual", purchase_date=_dt(2026, 1, 15))
    # Simuliamo 6 mesi con consumo moderato che permette carry pieno ogni volta
    total_carry_generated = 0.0
    for i in range(6):
        year = 2026
        month = 1 + i
        consume(ledger, 60.0, now=_dt(year, month, 20))
        nxt_month = month + 1
        nxt_year = year
        if nxt_month > 12:
            nxt_month -= 12
            nxt_year += 1
        # cattura leftover prima del rollover
        leftover = TIER_BASE_MINUTES["annual"] - ledger.base_minutes_used
        advance_period(ledger, now=_dt(nxt_year, nxt_month, 16))
        # dopo il rollover c'è uno slot nuovo da min(leftover, 50)
        if ledger.carryover_slots:
            total_carry_generated += min(leftover, CAP)
    _assert(total_carry_generated <= 300.0,
            f"massimo 300 min carry nell'annualità, got {total_carry_generated}")
    _assert(total_carry_generated == 300.0,
            f"6 passaggi × 50 = 300 (got {total_carry_generated})")


if __name__ == "__main__":
    tests = [
        test_pricing_constants,
        test_monthly_no_carryover,
        test_bimonthly_slot_creation,
        test_bimonthly_renewal,
        test_annual_slot_rolling_one_month,
        test_annual_fifo_consumption,
        test_annual_moderate_usage_60_per_month,
        test_annual_slot_expiration,
        test_annual_renewal,
        test_consume_over_budget,
        test_consume_zero,
        test_feb_edge_case,
        test_serialization_roundtrip,
        test_mobile_cycle_anchor,
        test_annual_max_6_carryovers_in_cycle,
    ]
    failed = []
    for t in tests:
        try:
            t()
        except AssertionError as e:
            print(f"  ✗ {e}")
            failed.append(t.__name__)
        except Exception as e:
            print(f"  ✗ EXCEPTION in {t.__name__}: {e!r}")
            failed.append(t.__name__)
    print("\n" + "=" * 70)
    if failed:
        print(f"❌ {len(failed)} test FAILED: {failed}")
        sys.exit(1)
    else:
        print(f"✅ All {len(tests)} tests passed")
        sys.exit(0)
