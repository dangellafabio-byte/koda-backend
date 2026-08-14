"""
subscription_ledger.py
=======================
Ledger a slot FIFO per il freemium di Koda.

Design principles (approvato da Fabio 2026-08-14):
- Ciclo mobile: mesi calcolati dalla data di acquisto (NOT calendar month).
  Es. acquisto 15 gennaio → M1: 15/01→14/02, M2: 15/02→14/03, ...
- Carryover a slot distinti: ogni slot mantiene traccia del mese di origine.
  MAI collassato in scalare (vincolo esplicito Fabio).
- Consumo FIFO: prima si esauriscono i carryover slots più vecchi, poi il
  budget base del mese corrente. Evita che i minuti carryover scadano
  inutilizzati (Opzione A).
- Slot lifetime per tier:
    monthly   → nessun slot generato
    bimonthly → slot da M1 vive solo in M2 (poi rinnovo cancella tutto)
    annual    → ogni slot vive 2 mesi (creato a fine M_N, disponibile in
                M_(N+1) e M_(N+2), scade fine M_(N+2))
- Rinnovo (fine ciclo tier): tutti gli slot vengono scartati, ledger
  resettato a M1 nuovo ciclo.

Il modulo è PURO: nessuna dipendenza da server.py, MongoDB o FastAPI.
Riceve/ritorna dict serializzabili. L'integrazione al pipeline voice
sarà uno step separato, dopo approvazione dei test unitari.
"""

from __future__ import annotations

from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from typing import List, Optional, Tuple, Dict, Any

from dateutil.relativedelta import relativedelta


# =============================================================================
# Costanti per tier — SOURCE OF TRUTH per pricing/quote Koda 2026-08
# =============================================================================
# Approvate da Fabio 2026-08-14. Modificare qui, non in server.py.

TIER_BASE_MINUTES: Dict[str, float] = {
    "monthly":   90.0,
    "bimonthly": 100.0,
    "annual":    110.0,
}

# Massimo minuti trasferibili come carryover DA UN SINGOLO MESE.
# NB: per l'annual, il ledger può contenere fino a 2 slot attivi
# contemporaneamente (residui di 2 mesi diversi), ma ciascuno cap 50.
TIER_MAX_CARRYOVER_PER_SLOT: Dict[str, float] = {
    "monthly":   0.0,   # nessun carryover
    "bimonthly": 50.0,  # 1 slot solo, cap 50, vive 1 mese
    "annual":    50.0,  # slot multipli, ciascuno cap 50, vivono 2 mesi
}

# Numero di mesi in cui uno slot resta "spendibile" dopo la sua creazione.
# monthly=0 significa "non si genera slot".
TIER_SLOT_LIFETIME_MONTHS: Dict[str, int] = {
    "monthly":   0,
    "bimonthly": 1,
    "annual":    2,
}

# Durata del ciclo di tier (dopo N mesi si rinnova e tutti gli slot muoiono).
TIER_CYCLE_LENGTH_MONTHS: Dict[str, int] = {
    "monthly":   1,
    "bimonthly": 2,
    "annual":    12,
}


# =============================================================================
# Utility date-time
# =============================================================================

def _now_utc() -> datetime:
    """Datetime corrente UTC (extractable per testing)."""
    return datetime.now(tz=timezone.utc)


def _parse_iso(iso: str) -> datetime:
    """Parse ISO8601 → datetime aware UTC. Tolera 'Z' finale."""
    if iso.endswith("Z"):
        iso = iso[:-1] + "+00:00"
    dt = datetime.fromisoformat(iso)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _iso(dt: datetime) -> str:
    """datetime → ISO8601 con offset UTC."""
    return dt.astimezone(timezone.utc).isoformat()


def _add_months(anchor: datetime, months: int) -> datetime:
    """
    Aggiunge N mesi mantenendo il "cycle_anchor_day".
    Es. anchor=2026-01-31, +1 mese → 2026-02-28 (clamped)
        anchor=2026-01-31, +2 mesi → 2026-03-31

    Nota: relativedelta gestisce correttamente il clamping al fondo del mese
    successivo quando il giorno anchor non esiste. Ciò rispecchia il
    comportamento di Apple/Google IAP e RevenueCat.
    """
    return anchor + relativedelta(months=months)


# =============================================================================
# Modelli dati (dataclass — nessuna dipendenza Pydantic per portabilità)
# =============================================================================

@dataclass
class CarryoverSlot:
    """
    Un singolo slot di carryover, generato dal residuo NON CONSUMATO
    di un mese specifico. Ogni slot è distinto — MAI collassare in scalare.
    """
    origin_month_index: int        # 1-based nel ciclo corrente (M1..M_cycle_length)
    origin_period_end_iso: str     # fine del mese che ha generato il residuo
    minutes_remaining: float       # residuo attuale (scala col consumo FIFO)
    expires_at_iso: str            # fine del mese in cui questo slot scade

    def is_expired(self, now: datetime) -> bool:
        return now >= _parse_iso(self.expires_at_iso)

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @staticmethod
    def from_dict(d: Dict[str, Any]) -> "CarryoverSlot":
        return CarryoverSlot(
            origin_month_index=int(d["origin_month_index"]),
            origin_period_end_iso=str(d["origin_period_end_iso"]),
            minutes_remaining=float(d["minutes_remaining"]),
            expires_at_iso=str(d["expires_at_iso"]),
        )


@dataclass
class SubscriptionLedger:
    """
    Ledger stateful per il conteggio minuti del freemium.
    Serializzabile via to_dict()/from_dict() per persistenza MongoDB.
    """
    plan: str                              # "monthly" | "bimonthly" | "annual"
    purchase_date_iso: str                 # ISO datetime del primo acquisto
    cycle_start_iso: str                   # inizio del CICLO corrente (rinnovato ogni CYCLE_LENGTH mesi)
    current_period_index: int              # mese 1-based nel ciclo (1..cycle_length)
    current_period_start_iso: str          # inizio mese corrente (mobile)
    current_period_end_iso: str            # fine mese corrente
    base_minutes_used: float               # consumati dal budget base del mese corrente
    carryover_slots: List[CarryoverSlot]   # slot residui, ordinati per origin_month_index
    last_rollover_check_iso: str           # ultima chiamata ad advance_period()

    def to_dict(self) -> Dict[str, Any]:
        d = asdict(self)
        d["carryover_slots"] = [s.to_dict() if hasattr(s, "to_dict") else s
                                 for s in self.carryover_slots]
        return d

    @staticmethod
    def from_dict(d: Dict[str, Any]) -> "SubscriptionLedger":
        slots = [CarryoverSlot.from_dict(s) for s in d.get("carryover_slots", [])]
        return SubscriptionLedger(
            plan=str(d["plan"]),
            purchase_date_iso=str(d["purchase_date_iso"]),
            cycle_start_iso=str(d["cycle_start_iso"]),
            current_period_index=int(d["current_period_index"]),
            current_period_start_iso=str(d["current_period_start_iso"]),
            current_period_end_iso=str(d["current_period_end_iso"]),
            base_minutes_used=float(d["base_minutes_used"]),
            carryover_slots=slots,
            last_rollover_check_iso=str(d["last_rollover_check_iso"]),
        )


# =============================================================================
# Factory — creazione di un ledger nuovo (all'acquisto o al rinnovo)
# =============================================================================

def create_ledger(plan: str, purchase_date: Optional[datetime] = None) -> SubscriptionLedger:
    """
    Crea un nuovo ledger per un tier appena acquistato/rinnovato.
    Il primo mese parte da purchase_date (o now UTC se non specificata).
    """
    if plan not in TIER_BASE_MINUTES:
        raise ValueError(f"Piano sconosciuto: {plan!r}. Attesi: {list(TIER_BASE_MINUTES.keys())}")

    now = purchase_date or _now_utc()
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)

    period_end = _add_months(now, 1)

    return SubscriptionLedger(
        plan=plan,
        purchase_date_iso=_iso(now),
        cycle_start_iso=_iso(now),
        current_period_index=1,
        current_period_start_iso=_iso(now),
        current_period_end_iso=_iso(period_end),
        base_minutes_used=0.0,
        carryover_slots=[],
        last_rollover_check_iso=_iso(now),
    )


# =============================================================================
# Rollover — avanzamento periodo con creazione slot FIFO
# =============================================================================

def advance_period(ledger: SubscriptionLedger, now: Optional[datetime] = None) -> SubscriptionLedger:
    """
    Verifica se `now` è oltre `current_period_end`. Se sì, avanza il periodo:
      1. Calcola leftover base del mese appena terminato.
      2. Se il tier prevede carryover, crea uno slot con leftover cap.
      3. Rimuove slot scaduti (expires_at <= now).
      4. Se siamo a fine ciclo (M > cycle_length), scarta TUTTI gli slot
         e riparte da M1 con nuovo cycle_start.
      5. Reset base_minutes_used, aggiorna period start/end e index.

    Chiamabile ricorsivamente in un loop: se l'utente non ha usato l'app
    per 3 mesi, avanziamo 3 mesi in cascata. Ogni transizione mensile viene
    processata singolarmente per generare gli slot corretti.

    Idempotente: se now è dentro il periodo corrente, no-op.
    """
    now = now or _now_utc()
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)

    plan = ledger.plan
    base = TIER_BASE_MINUTES[plan]
    slot_cap = TIER_MAX_CARRYOVER_PER_SLOT[plan]
    slot_lifetime = TIER_SLOT_LIFETIME_MONTHS[plan]
    cycle_length = TIER_CYCLE_LENGTH_MONTHS[plan]

    guard = 0  # protezione anti-loop infinito
    while now >= _parse_iso(ledger.current_period_end_iso):
        guard += 1
        if guard > 120:  # max 10 anni di catch-up
            break

        # Fase 1 — leftover del mese che sta terminando
        leftover = max(0.0, base - ledger.base_minutes_used)
        old_period_end_iso = ledger.current_period_end_iso
        old_period_index = ledger.current_period_index

        # Fase 2 — determinazione next period
        next_period_index = old_period_index + 1
        is_cycle_end = next_period_index > cycle_length

        # Fase 3 — generazione slot (SE il tier lo prevede E non siamo a fine ciclo)
        # A fine ciclo, il residuo del mese N=cycle_length viene comunque scartato
        # perché tutti gli slot vengono azzerati.
        if slot_cap > 0 and slot_lifetime > 0 and not is_cycle_end and leftover > 0:
            new_slot_expires = _add_months(_parse_iso(old_period_end_iso), slot_lifetime)
            new_slot = CarryoverSlot(
                origin_month_index=old_period_index,
                origin_period_end_iso=old_period_end_iso,
                minutes_remaining=min(leftover, slot_cap),
                expires_at_iso=_iso(new_slot_expires),
            )
            ledger.carryover_slots.append(new_slot)

        # Fase 4 — advance del periodo
        new_period_start = _parse_iso(ledger.current_period_end_iso)
        new_period_end = _add_months(new_period_start, 1)

        if is_cycle_end:
            # Rinnovo tier: cancella TUTTI gli slot, reset index a 1, nuovo cycle_start
            ledger.carryover_slots = []
            ledger.cycle_start_iso = _iso(new_period_start)
            ledger.current_period_index = 1
        else:
            ledger.current_period_index = next_period_index

        ledger.current_period_start_iso = _iso(new_period_start)
        ledger.current_period_end_iso = _iso(new_period_end)
        ledger.base_minutes_used = 0.0

        # Fase 5 — pulizia slot scaduti (dopo l'update dell'index)
        # Uno slot expires_at <= new_period_start è scaduto ad inizio nuovo mese.
        ledger.carryover_slots = [
            s for s in ledger.carryover_slots
            if _parse_iso(s.expires_at_iso) > new_period_start
        ]

    ledger.last_rollover_check_iso = _iso(now)

    # Ordina slot per FIFO (più vecchio = index più basso all'inizio della lista)
    ledger.carryover_slots.sort(key=lambda s: s.origin_month_index)

    return ledger


# =============================================================================
# Consumo FIFO — carryover-first, poi base (Opzione A, Fabio 2026-08-14)
# =============================================================================

@dataclass
class ConsumeResult:
    """Risultato dettagliato di un consume(), utile per debug e logging."""
    consumed_from_slots: float       # totale minuti scalati dagli slot carryover
    consumed_from_base: float        # totale minuti scalati dal base del mese
    total_consumed: float            # consumed_from_slots + consumed_from_base
    requested: float                 # minuti richiesti dal caller
    unfulfilled: float               # requested - total_consumed (>0 = paywall)
    slots_touched: List[Dict[str, Any]]  # dettaglio per audit


def consume(
    ledger: SubscriptionLedger,
    minutes: float,
    now: Optional[datetime] = None,
) -> ConsumeResult:
    """
    Scala `minutes` dal ledger seguendo FIFO carryover-first:
      1. Chiama advance_period per allineare al presente.
      2. Prende dagli slot più vecchi (origin_month_index crescente).
      3. Quando gli slot sono esauriti, incrementa base_minutes_used
         fino al tetto TIER_BASE_MINUTES[plan].
      4. Se le richieste eccedono il totale disponibile, `unfulfilled` > 0.
         Il caller decide cosa fare (bloccare turno, notificare paywall, ecc.).

    Il ledger viene mutato in-place. Ritorna un ConsumeResult per audit/log.
    """
    if minutes < 0:
        raise ValueError(f"minutes deve essere >= 0, ricevuto {minutes}")

    advance_period(ledger, now=now)

    result = ConsumeResult(
        consumed_from_slots=0.0,
        consumed_from_base=0.0,
        total_consumed=0.0,
        requested=minutes,
        unfulfilled=0.0,
        slots_touched=[],
    )

    remaining_to_consume = minutes

    # Fase 1 — FIFO dai carryover slots (più vecchi first)
    ledger.carryover_slots.sort(key=lambda s: s.origin_month_index)
    for slot in ledger.carryover_slots:
        if remaining_to_consume <= 0:
            break
        if slot.minutes_remaining <= 0:
            continue
        take = min(slot.minutes_remaining, remaining_to_consume)
        slot.minutes_remaining -= take
        remaining_to_consume -= take
        result.consumed_from_slots += take
        result.slots_touched.append({
            "origin_month_index": slot.origin_month_index,
            "taken": take,
            "left_after": slot.minutes_remaining,
        })

    # Rimuovi slot esauriti (minutes_remaining <= 0)
    ledger.carryover_slots = [s for s in ledger.carryover_slots if s.minutes_remaining > 1e-9]

    # Fase 2 — dal budget base del mese corrente
    if remaining_to_consume > 0:
        base_max = TIER_BASE_MINUTES[ledger.plan]
        base_avail = max(0.0, base_max - ledger.base_minutes_used)
        take = min(base_avail, remaining_to_consume)
        ledger.base_minutes_used += take
        remaining_to_consume -= take
        result.consumed_from_base += take

    result.total_consumed = result.consumed_from_slots + result.consumed_from_base
    result.unfulfilled = max(0.0, minutes - result.total_consumed)

    return result


# =============================================================================
# Reporting — riassunto per UI e endpoint /api/subscription/status
# =============================================================================

def remaining_summary(
    ledger: SubscriptionLedger,
    now: Optional[datetime] = None,
) -> Dict[str, Any]:
    """
    Ritorna dict human-readable per UI e /api/subscription/status.
    Applica advance_period() prima di calcolare (assicura freshness).
    """
    advance_period(ledger, now=now)

    base_max = TIER_BASE_MINUTES[ledger.plan]
    base_remaining = max(0.0, base_max - ledger.base_minutes_used)
    slots_remaining_total = sum(s.minutes_remaining for s in ledger.carryover_slots)
    total_available = base_remaining + slots_remaining_total

    return {
        "plan": ledger.plan,
        "current_period_index": ledger.current_period_index,
        "cycle_length_months": TIER_CYCLE_LENGTH_MONTHS[ledger.plan],
        "current_period_start": ledger.current_period_start_iso,
        "current_period_end": ledger.current_period_end_iso,
        "base_minutes_total": base_max,
        "base_minutes_used": ledger.base_minutes_used,
        "base_minutes_remaining": base_remaining,
        "carryover_slots": [
            {
                "origin_month_index": s.origin_month_index,
                "minutes_remaining": s.minutes_remaining,
                "expires_at": s.expires_at_iso,
            }
            for s in ledger.carryover_slots
        ],
        "carryover_minutes_total": slots_remaining_total,
        "total_available_minutes": total_available,
    }
