"""
Unit tests per subscription_ledger.py

Coverage completa degli scenari approvati con Fabio (2026-08-14):
- Monthly: consumo + fine mese senza carryover
- Bimonthly M1→M2: creazione slot con cap 50
- Bimonthly renewal: reset totale a fine M2
- Annual peak M3: 110 base + 50 (da M1) + 50 (da M2) = 210 max disponibile
- Annual FIFO: consumo eccessivo scala prima gli slot più vecchi
- Annual slot expiration: slot da M1 scade a fine M3
- Annual renewal (fine M12): tutti gli slot vengono scartati
- Consume oltre budget: unfulfilled > 0
- Consume zero: no-op
- Edge case Feb 30: relativedelta clampa correttamente
"""

import sys
import pathlib
from datetime import datetime, timezone, timedelta

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

from subscription_ledger import (  # noqa: E402
    TIER_BASE_MINUTES,
    TIER_MAX_CARRYOVER_PER_SLOT,
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


# ==============================================================================
# Helpers
# ==============================================================================

def _dt(y: int, m: int, d: int, h: int = 12, minute: int = 0) -> datetime:
    """Helper to build UTC datetimes concisely."""
    return datetime(y, m, d, h, minute, tzinfo=timezone.utc)


def _assert(cond, msg):
    if not cond:
        raise AssertionError(f"FAIL: {msg}")
    print(f"  ✓ {msg}")


# ==============================================================================
# TEST 1 — Monthly: nessun carryover, reset totale a fine mese
# ==============================================================================

def test_monthly_no_carryover():
    print("\n[TEST 1] Monthly: nessun carryover, reset a fine mese")

    purchase = _dt(2026, 1, 15)
    ledger = create_ledger("monthly", purchase_date=purchase)

    # Consumo 60 min in M1 (residuo 30, ma monthly=0 carryover)
    result = consume(ledger, 60.0, now=_dt(2026, 2, 1))
    _assert(result.total_consumed == 60.0, "consumo 60 min riuscito")
    _assert(result.consumed_from_slots == 0.0, "nessun consumo da slot (non esistono)")
    _assert(result.consumed_from_base == 60.0, "tutto da base")
    _assert(ledger.base_minutes_used == 60.0, "base_minutes_used = 60")

    # Avanza a fine mese (dopo il 14 febbraio) → nuovo periodo M1 nuovo ciclo (monthly cycle=1)
    advance_period(ledger, now=_dt(2026, 2, 20))
    _assert(len(ledger.carryover_slots) == 0, "nessun slot generato (monthly)")
    _assert(ledger.base_minutes_used == 0.0, "base resettato a 0")
    _assert(ledger.current_period_index == 1, "index resettato a M1 (nuovo ciclo)")

    # Nuovo mese: budget pieno 90
    summary = remaining_summary(ledger, now=_dt(2026, 2, 20))
    _assert(summary["base_minutes_remaining"] == 90.0, "budget pieno nel nuovo mese")
    _assert(summary["carryover_minutes_total"] == 0.0, "carryover 0")


# ==============================================================================
# TEST 2 — Bimonthly M1→M2: slot creato con cap 50
# ==============================================================================

def test_bimonthly_slot_creation():
    print("\n[TEST 2] Bimonthly M1→M2: slot creato con cap 50")

    purchase = _dt(2026, 1, 15)
    ledger = create_ledger("bimonthly", purchase_date=purchase)

    # M1: consumo 30 min → leftover 70 (ma cap 50)
    consume(ledger, 30.0, now=_dt(2026, 1, 20))
    _assert(ledger.base_minutes_used == 30.0, "M1: base_used = 30")

    # Avanza a M2
    advance_period(ledger, now=_dt(2026, 2, 20))
    _assert(ledger.current_period_index == 2, "siamo in M2")
    _assert(len(ledger.carryover_slots) == 1, "1 slot creato")
    _assert(ledger.carryover_slots[0].minutes_remaining == 50.0,
            "slot ha 50 min (capped, non 70)")
    _assert(ledger.carryover_slots[0].origin_month_index == 1, "slot da M1")

    # Verifica scadenza slot = fine M2
    summary = remaining_summary(ledger, now=_dt(2026, 2, 20))
    _assert(summary["total_available_minutes"] == 150.0, "M2 ha 100 base + 50 slot = 150")


# ==============================================================================
# TEST 3 — Bimonthly renewal: fine M2 scarta tutto e resetta a M1
# ==============================================================================

def test_bimonthly_renewal():
    print("\n[TEST 3] Bimonthly renewal: fine M2 scarta tutto")

    purchase = _dt(2026, 1, 15)
    ledger = create_ledger("bimonthly", purchase_date=purchase)

    # M1: consumo 30, avanza a M2 (crea slot 50)
    consume(ledger, 30.0, now=_dt(2026, 1, 20))
    advance_period(ledger, now=_dt(2026, 2, 20))
    _assert(len(ledger.carryover_slots) == 1, "M2: slot presente")

    # M2: consumo 20 (leftover 80, ma bimonthly ha 1 slot solo, M2→ciclo nuovo)
    consume(ledger, 20.0, now=_dt(2026, 2, 25))

    # Renewal: avanza oltre fine M2
    advance_period(ledger, now=_dt(2026, 3, 20))
    _assert(ledger.current_period_index == 1, "reset a M1 nuovo ciclo")
    _assert(len(ledger.carryover_slots) == 0, "TUTTI gli slot scartati al renewal")
    _assert(ledger.base_minutes_used == 0.0, "base resettato")


# ==============================================================================
# TEST 4 — Annual peak M3: 210 min disponibili SE M2 non ha consumo
# ==============================================================================
# La specifica dice "picco 210 al mese 3" come MASSIMO CUMULABILE. Con
# carryover-first, il picco 210 si materializza solo se M2 non tocca gli
# slot vecchi. Test 5b copre lo scenario "60/60 moderato" invece.

def test_annual_peak_m3():
    print("\n[TEST 4] Annual peak M3: 110 base + 50 (M1) + 50 (M2) = 210 (M2 senza consumo)")

    purchase = _dt(2026, 1, 15)
    ledger = create_ledger("annual", purchase_date=purchase)

    # M1: consumo 60 → residuo 50 → slot A (50, expires end M3)
    consume(ledger, 60.0, now=_dt(2026, 1, 20))
    advance_period(ledger, now=_dt(2026, 2, 20))
    _assert(len(ledger.carryover_slots) == 1, "M2: 1 slot (da M1)")
    _assert(ledger.carryover_slots[0].minutes_remaining == 50.0, "slot M1 = 50")

    # M2: NESSUN consumo → residuo base 110 → slot B (50, capped, expires end M4)
    # Slot A resta intatto perché non è stato toccato.
    advance_period(ledger, now=_dt(2026, 3, 20))
    _assert(len(ledger.carryover_slots) == 2, "M3: 2 slot attivi (da M1 e M2)")

    # Verifica origin indexes
    slot_indexes = sorted(s.origin_month_index for s in ledger.carryover_slots)
    _assert(slot_indexes == [1, 2], "slot da M1 e M2 presenti")

    # Verifica peak disponibile in M3
    summary = remaining_summary(ledger, now=_dt(2026, 3, 20))
    _assert(summary["total_available_minutes"] == 210.0,
            f"M3 peak = 210 (got {summary['total_available_minutes']})")
    _assert(summary["carryover_minutes_total"] == 100.0, "100 min totali negli slot")
    _assert(summary["base_minutes_remaining"] == 110.0, "base intatto in M3")


# ==============================================================================
# TEST 5 — Annual FIFO: consumo pesante scala prima gli slot più vecchi
# ==============================================================================
# Preludio identico a Test 4 (M2 senza consumo), poi in M3 consumo 130 e
# verifico che FIFO svuoti prima Slot A, poi Slot B, poi base.

def test_annual_fifo_consumption():
    print("\n[TEST 5] Annual FIFO: carryover-first, slot più vecchio first")

    purchase = _dt(2026, 1, 15)
    ledger = create_ledger("annual", purchase_date=purchase)

    # Setup: arriva a M3 con 2 slot da 50 (M2 senza consumo, come test 4)
    consume(ledger, 60.0, now=_dt(2026, 1, 20))
    advance_period(ledger, now=_dt(2026, 2, 20))
    # NB: NON consumiamo in M2, così arriviamo in M3 con 2 slot pieni
    advance_period(ledger, now=_dt(2026, 3, 20))
    _assert(len(ledger.carryover_slots) == 2, "M3 setup: 2 slot pieni")

    # M3: consumo 130 → attesa: 50 da slot M1 (svuota), 50 da slot M2 (svuota), 30 da base
    result = consume(ledger, 130.0, now=_dt(2026, 3, 25))
    _assert(result.consumed_from_slots == 100.0, "100 dagli slot")
    _assert(result.consumed_from_base == 30.0, "30 dal base")
    _assert(result.total_consumed == 130.0, "totale 130")
    _assert(len(ledger.carryover_slots) == 0, "entrambi gli slot svuotati e rimossi")
    _assert(ledger.base_minutes_used == 30.0, "base = 30")

    # Verifica ordine FIFO: primo slot toccato deve essere M1
    _assert(result.slots_touched[0]["origin_month_index"] == 1, "primo touched = M1")
    _assert(result.slots_touched[1]["origin_month_index"] == 2, "secondo touched = M2")


# ==============================================================================
# TEST 5b — Annual uso moderato 60/60: slot rigenera OGNI mese
# ==============================================================================
# Scenario esplicito richiesto da Fabio (2026-08-14):
#   Uso moderato costante di 60 min ogni mese. Regola chiave verificata:
#   il NUOVO slot per mese N+1 dipende SOLO dal residuo del BASE di
#   mese N, MAI da quanto residua negli slot vecchi. Quindi anche se
#   Slot A viene svuotato in M2 (FIFO carryover-first), Slot B nasce
#   pieno (50) perché il base di M2 è stato consumato solo per 10 min.

def test_annual_moderate_usage_60_per_month():
    print("\n[TEST 5b] Annual 60/60: nuovo slot NON ridotto dal consumo di slot vecchi")

    purchase = _dt(2026, 1, 15)
    ledger = create_ledger("annual", purchase_date=purchase)

    # M1: consumo 60 dal base → residuo base 50 → Slot A (50)
    consume(ledger, 60.0, now=_dt(2026, 1, 20))
    _assert(ledger.base_minutes_used == 60.0, "M1: base_used = 60")

    # Transizione M1→M2
    advance_period(ledger, now=_dt(2026, 2, 20))
    _assert(len(ledger.carryover_slots) == 1, "M2 start: Slot A presente")
    _assert(ledger.carryover_slots[0].minutes_remaining == 50.0, "Slot A = 50")

    # M2: consumo 60 → carryover-first: 50 da Slot A (svuotato), 10 dal base
    result_m2 = consume(ledger, 60.0, now=_dt(2026, 2, 25))
    _assert(result_m2.consumed_from_slots == 50.0, "M2: 50 min da Slot A")
    _assert(result_m2.consumed_from_base == 10.0, "M2: 10 min dal base")
    _assert(ledger.base_minutes_used == 10.0,
            f"M2: base_used = 10 (SOLO base consumption, non Slot A) — got {ledger.base_minutes_used}")
    _assert(len(ledger.carryover_slots) == 0, "M2: Slot A svuotato e rimosso")

    # Transizione M2→M3 — REGOLA CHIAVE:
    # leftover base M2 = 110 - 10 = 100 → capped 50 → Slot B(50, PIENO)
    # Il nuovo slot NON è ridotto dal fatto che Slot A sia stato consumato.
    advance_period(ledger, now=_dt(2026, 3, 20))
    _assert(len(ledger.carryover_slots) == 1, "M3 start: Slot B presente")
    slot_b = ledger.carryover_slots[0]
    _assert(slot_b.origin_month_index == 2, "Slot B origin = M2")
    _assert(slot_b.minutes_remaining == 50.0,
            f"Slot B PIENO a 50 (non ridotto dal consumo di Slot A) — got {slot_b.minutes_remaining}")

    # Disponibile in M3 = 110 base + 50 Slot B = 160
    summary_m3 = remaining_summary(ledger, now=_dt(2026, 3, 20))
    _assert(summary_m3["total_available_minutes"] == 160.0,
            f"M3: 160 min disponibili (110 base + 50 Slot B) — got {summary_m3['total_available_minutes']}")

    # M3: consumo 60 → 50 da Slot B (svuotato), 10 dal base → Slot C(50) a fine M3
    consume(ledger, 60.0, now=_dt(2026, 3, 25))
    _assert(ledger.base_minutes_used == 10.0, "M3: base_used = 10")

    advance_period(ledger, now=_dt(2026, 4, 20))
    _assert(len(ledger.carryover_slots) == 1, "M4 start: Slot C presente")
    _assert(ledger.carryover_slots[0].minutes_remaining == 50.0,
            "Slot C PIENO a 50 (regola stabile mese dopo mese)")
    _assert(ledger.carryover_slots[0].origin_month_index == 3, "Slot C origin = M3")

    # M4: consumo 60 → stesso pattern → Slot D(50)
    consume(ledger, 60.0, now=_dt(2026, 4, 25))
    advance_period(ledger, now=_dt(2026, 5, 20))
    _assert(len(ledger.carryover_slots) == 1, "M5 start: Slot D presente")
    _assert(ledger.carryover_slots[0].minutes_remaining == 50.0, "Slot D pieno")
    _assert(ledger.carryover_slots[0].origin_month_index == 4, "Slot D origin = M4")

    print("  ✅ regola verificata: uso moderato costante rigenera slot pieno ogni mese")


# ==============================================================================
# TEST 6 — Annual slot expiration: slot M1 scade a fine M3
# ==============================================================================

def test_annual_slot_expiration():
    print("\n[TEST 6] Annual slot expiration: slot M1 scade a fine M3, non arriva in M4")

    purchase = _dt(2026, 1, 15)
    ledger = create_ledger("annual", purchase_date=purchase)

    # M1: consumo 60 → slot A (50, expires end M3)
    consume(ledger, 60.0, now=_dt(2026, 1, 20))
    advance_period(ledger, now=_dt(2026, 2, 20))
    _assert(len(ledger.carryover_slots) == 1, "M2: slot M1 presente")

    # M2: NON consumo → residuo 100 → slot B (50, expires end M4)
    advance_period(ledger, now=_dt(2026, 3, 20))
    _assert(len(ledger.carryover_slots) == 2, "M3: 2 slot")

    # M3: NON consumo → residuo 110 → slot C (50, expires end M5)
    advance_period(ledger, now=_dt(2026, 4, 20))

    # M4: slot A (da M1) deve essere scaduto (expires end M3 = ~15 apr)
    # slot B (da M2) ancora valido (expires end M4 = ~15 mag)
    # slot C (da M3) ancora valido (expires end M5 = ~15 giu)
    active_indexes = sorted(s.origin_month_index for s in ledger.carryover_slots)
    _assert(1 not in active_indexes, "slot M1 SCADUTO (non più in ledger)")
    _assert(2 in active_indexes, "slot M2 ancora presente")
    _assert(3 in active_indexes, "slot M3 ancora presente")
    _assert(len(active_indexes) == 2, f"esattamente 2 slot attivi, got {active_indexes}")


# ==============================================================================
# TEST 7 — Annual renewal: fine M12 scarta tutti gli slot
# ==============================================================================

def test_annual_renewal():
    print("\n[TEST 7] Annual renewal: fine M12 scarta TUTTI gli slot")

    purchase = _dt(2026, 1, 15)
    ledger = create_ledger("annual", purchase_date=purchase)

    # Simula anno intero: avanza direttamente a M12 con consumo minimo
    # Un modo semplice: consumo 1 min ogni mese per generare qualche slot
    for month_offset in range(11):  # M1 a M11
        now = _dt(2026, 1 + month_offset, 20) if month_offset < 11 else _dt(2026, 12, 20)
        consume(ledger, 60.0, now=now)
        advance_period(ledger, now=_dt(2026, 2 + month_offset, 16) if month_offset < 11 else _dt(2026, 12, 20))

    # Ora dovremmo essere in M12 con vari slot ancora vivi (M10, M11)
    _assert(ledger.current_period_index == 12, f"in M12, got {ledger.current_period_index}")

    # Consuma poco in M12, poi avanza oltre fine M12 (rinnovo annuale = ~15 gennaio 2027)
    consume(ledger, 30.0, now=_dt(2026, 12, 20))
    advance_period(ledger, now=_dt(2027, 1, 20))

    _assert(ledger.current_period_index == 1, "reset a M1 nuovo anno")
    _assert(len(ledger.carryover_slots) == 0, "TUTTI gli slot scartati al renewal annuale")
    _assert(ledger.base_minutes_used == 0.0, "base resettato")


# ==============================================================================
# TEST 8 — Consume oltre budget: unfulfilled > 0
# ==============================================================================

def test_consume_over_budget():
    print("\n[TEST 8] Consume oltre budget disponibile: unfulfilled > 0")

    ledger = create_ledger("monthly", purchase_date=_dt(2026, 1, 15))
    result = consume(ledger, 200.0, now=_dt(2026, 1, 20))

    _assert(result.consumed_from_base == 90.0, "consumati max base (90)")
    _assert(result.total_consumed == 90.0, "totale = 90")
    _assert(result.unfulfilled == 110.0, "unfulfilled = 200-90 = 110")
    _assert(ledger.base_minutes_used == 90.0, "base saturato")


# ==============================================================================
# TEST 9 — Consume zero: no-op
# ==============================================================================

def test_consume_zero():
    print("\n[TEST 9] Consume 0 minuti: no-op ma advance_period comunque chiamato")

    ledger = create_ledger("monthly", purchase_date=_dt(2026, 1, 15))
    result = consume(ledger, 0.0, now=_dt(2026, 1, 20))

    _assert(result.total_consumed == 0.0, "nessun consumo")
    _assert(result.unfulfilled == 0.0, "nessun unfulfilled")
    _assert(ledger.base_minutes_used == 0.0, "base intatto")


# ==============================================================================
# TEST 10 — Feb 30 edge case: relativedelta clampa
# ==============================================================================

def test_feb_edge_case():
    print("\n[TEST 10] Feb 30 edge case: acquisto 31 gennaio → M2 clamps a 28 feb")

    # Acquisto 31 gennaio 2026 (Feb 2026 = 28 giorni, non è bisestile)
    purchase = _dt(2026, 1, 31)
    ledger = create_ledger("monthly", purchase_date=purchase)

    end_m1 = _parse_iso(ledger.current_period_end_iso)
    _assert(end_m1.month == 2 and end_m1.day == 28,
            f"M1 finisce 28 feb (got {end_m1.date()})")

    # Avanza a M2 (dopo 28 feb)
    advance_period(ledger, now=_dt(2026, 3, 5))
    end_m2 = _parse_iso(ledger.current_period_end_iso)
    _assert(end_m2.month == 3 and end_m2.day == 28,
            f"M2 finisce 28 mar (got {end_m2.date()})")


# ==============================================================================
# TEST 11 — Serializzazione round-trip (MongoDB persistence)
# ==============================================================================

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
    _assert(len(restored.carryover_slots) == len(ledger.carryover_slots),
            "numero slot preservato")
    _assert(restored.carryover_slots[0].minutes_remaining ==
            ledger.carryover_slots[0].minutes_remaining, "slot data preservato")


# ==============================================================================
# TEST 12 — Ciclo mobile: la data anchor si mantiene
# ==============================================================================

def test_mobile_cycle_anchor():
    print("\n[TEST 12] Ciclo mobile: anchor day mantenuto attraverso i mesi")

    purchase = _dt(2026, 1, 15, 14, 30)
    ledger = create_ledger("bimonthly", purchase_date=purchase)

    # M1: 15 gen → 15 feb
    m1_start = _parse_iso(ledger.current_period_start_iso)
    m1_end = _parse_iso(ledger.current_period_end_iso)
    _assert(m1_start.day == 15, f"M1 inizia il 15 (got {m1_start.day})")
    _assert(m1_end.day == 15, f"M1 finisce il 15 feb (got {m1_end.day})")

    # M2
    advance_period(ledger, now=_dt(2026, 2, 20))
    m2_start = _parse_iso(ledger.current_period_start_iso)
    m2_end = _parse_iso(ledger.current_period_end_iso)
    _assert(m2_start.day == 15, "M2 inizia il 15 feb")
    _assert(m2_end.day == 15, "M2 finisce il 15 mar")


# ==============================================================================
# Runner
# ==============================================================================

if __name__ == "__main__":
    tests = [
        test_monthly_no_carryover,
        test_bimonthly_slot_creation,
        test_bimonthly_renewal,
        test_annual_peak_m3,
        test_annual_fifo_consumption,
        test_annual_moderate_usage_60_per_month,
        test_annual_slot_expiration,
        test_annual_renewal,
        test_consume_over_budget,
        test_consume_zero,
        test_feb_edge_case,
        test_serialization_roundtrip,
        test_mobile_cycle_anchor,
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
