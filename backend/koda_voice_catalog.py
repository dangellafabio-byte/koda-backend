"""
koda_voice_catalog — Catalogo voci di Ollenya + disponibilità per provider.
===========================================================================

Fonte UNICA di verità per:
  * Nomi/descrizioni delle voci esposti al frontend
  * Mapping voce brand → ElevenLabs voice_id (identico al CURATED_VOICES
    in server.py — non duplicare, qui è SOLO lato catalogo API).
  * Mapping voce brand → Inworld voice_id (configurabile via env, con
    default sicuri che non assumono audio approvato).
  * Disponibilità per provider: una voce può essere "available" o
    "unavailable_on_provider". La UI deve mostrare DISABILITATE (con
    tooltip) le voci non disponibili per il provider selezionato — NO
    selezione destinata a fallire.

L'etichetta UI mostrata nelle Impostazioni è "Voce di Ollenya" (non
"Voce di Koda"), per allineamento al rebranding Ollenya.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Optional


@dataclass(frozen=True)
class VoiceEntry:
    """Una voce brand (Cielo/Vento) con i suoi mapping provider."""
    key: str                        # "cielo" | "vento"
    name: str                       # "Cielo" | "Vento"
    gender: str                     # "femminile" | "maschile"
    description: str
    elevenlabs_voice_id: Optional[str]
    inworld_voice_id: Optional[str]
    inworld_delivery_mode: Optional[str] = None  # override per voce
    # Se False → la UI mostra la voce come disabilitata quando il
    # provider selezionato è l'altro. "available_on" lista i provider
    # su cui la voce è spendibile per generare audio.
    available_on: tuple = ()


# =============================================================================
# Catalogo
# =============================================================================
# ElevenLabs: usiamo gli ID esistenti già usati in server.py CURATED_VOICES.
# Inworld: la Cielo-equivalente è configurabile via env; Vento non è ancora
# supportato su Inworld in questa fase (Fabio deve ancora validare il voice
# matching maschile).

_INWORLD_CIELO_VOICE_ID = os.environ.get(
    "INWORLD_VOICE_CIELO", ""
).strip() or None
_INWORLD_VENTO_VOICE_ID = os.environ.get(
    "INWORLD_VOICE_VENTO", ""
).strip() or None  # None = non ancora validato → UI mostra disabilitato
_INWORLD_CIELO_DELIVERY = os.environ.get(
    "INWORLD_DELIVERY_CIELO", ""
).strip().upper() or None
_INWORLD_VENTO_DELIVERY = os.environ.get(
    "INWORLD_DELIVERY_VENTO", ""
).strip().upper() or None


CATALOG: tuple = (
    VoiceEntry(
        key="cielo",
        name="Cielo",
        gender="femminile",
        description="La voce femminile di Ollenya.",
        elevenlabs_voice_id="POuqf18evoXOKIqV2Px7",
        inworld_voice_id=_INWORLD_CIELO_VOICE_ID,
        inworld_delivery_mode=_INWORLD_CIELO_DELIVERY,
        available_on=tuple(
            ["elevenlabs"]
            + (["inworld"] if _INWORLD_CIELO_VOICE_ID else [])
        ),
    ),
    VoiceEntry(
        key="vento",
        name="Vento",
        gender="maschile",
        description="La voce maschile di Ollenya.",
        elevenlabs_voice_id="ll9WG7PDTuyHwgC5MD6g",
        inworld_voice_id=_INWORLD_VENTO_VOICE_ID,
        inworld_delivery_mode=_INWORLD_VENTO_DELIVERY,
        available_on=tuple(
            ["elevenlabs"]
            + (["inworld"] if _INWORLD_VENTO_VOICE_ID else [])
        ),
    ),
)


# =============================================================================
# Helpers
# =============================================================================
def list_voices_public() -> list:
    """Serializzazione per API: nasconde segreti/ID tecnici inworld quando
    non ancora disponibili per Inworld. Il frontend NON ha bisogno dei
    voice_id tecnici Inworld (li usa solo il backend). Esponiamo:
      * key, name, gender, description
      * elevenlabs_voice_id (già pubblico in CURATED_VOICES oggi)
      * available_on (lista provider)
    """
    out = []
    for v in CATALOG:
        out.append({
            "key": v.key,
            "name": v.name,
            "gender": v.gender,
            "description": v.description,
            "elevenlabs_voice_id": v.elevenlabs_voice_id,
            "available_on": list(v.available_on),
        })
    return out


def find_by_key(key: str) -> Optional[VoiceEntry]:
    k = (key or "").lower().strip()
    for v in CATALOG:
        if v.key == k:
            return v
    return None


def find_by_elevenlabs_voice_id(voice_id: str) -> Optional[VoiceEntry]:
    """Reverse lookup. Utile se il profilo contiene tts_voice_id ElevenLabs
    e vogliamo capire quale voce brand (cielo/vento) corrisponde."""
    v = (voice_id or "").strip()
    for e in CATALOG:
        if e.elevenlabs_voice_id == v:
            return e
    return None


def is_voice_available_on(voice_key: str, provider: str) -> bool:
    """True se la voce (chiave brand) è disponibile sul provider richiesto."""
    v = find_by_key(voice_key)
    if not v:
        return False
    return provider in v.available_on
