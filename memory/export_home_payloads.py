#!/usr/bin/env python3
"""
Ollenya — Esportatore payload Home (anonimizzato, zero rete, zero DB)
=====================================================================

Scopo
-----
Esportare in file JSON i request-body ESATTI che il percorso Home
(`_fast_pipeline_task`) invia a Claude Haiku 4.5, ricostruendoli con lo
stesso codice del backend (server.py) ma usando dati FITTIZI.

Perché serve
------------
Lo script `measure_prompt_tokens_v3.py` deve poter contare i token
senza importare server.py (ambiente dell'utente, laptop, review esterna).
Quindi i payload vengono materializzati qui, UNA VOLTA, in JSON.

Garanzie
--------
  * Zero chiamate a pagamento (nessuna chiamata LLM/TTS/STT).
  * Zero scritture su MongoDB (il client Motor è lazy, nessuna query).
  * Zero connessioni in uscita.
  * Dati 100% fittizi (profilo "MARIO", memorie `concept_0..9`,
    situazioni `persona_0..2`, nessun dato reale toccato).

Side effect dell'import `server.py`
-----------------------------------
Documentati in dettaglio nella consegna. Riassunto:
  * `AsyncIOMotorClient` creato ma NON connesso.
  * `FastAPI()` istanziato ma NON avviato (nessun socket in ascolto).
  * Logging configurato (stdout only).
  * litellm cache_control patch applicata (no-op, in-memoria).

Output
------
  /app/memory/home_payloads/
    01_minimo__profilo_e_1_turno.json
    02_medio__10_turni_10_memorie.json
    03_realistico__completo_con_user_text.json
    _README.md

Versione: 1.0 (2026-10-13)
"""
from __future__ import annotations
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, "/app/backend")
os.environ.setdefault("MONGO_URL", "mongodb://localhost:27017")
os.environ.setdefault("DB_NAME", "placeholder_no_io")

import server as srv  # side effects documentati sopra
from server import _build_fast_system_prompt, _format_history_for_llm
from server import Profile, TimelineEntry, Memory, Situation

OUT_DIR = Path(__file__).parent / "home_payloads"
OUT_DIR.mkdir(parents=True, exist_ok=True)

MODEL = "claude-haiku-4-5-20251001"
MAX_TOKENS_OUTPUT = 320  # server.py:15373


# -----------------------------------------------------------------------------
# Builder fittizi (identici a quelli usati da measure_prompt_tokens_v2.py).
# -----------------------------------------------------------------------------
def build_profile() -> Profile:
    return Profile(
        profile_id="TEST-" + "a" * 32,
        name="MARIO",
        gender="m",
        language="it",
        tone_preference="warm",
        voice_id="POuqf18evoXOKIqV2Px7",
        subscription_tier="monthly",
        onboarded=True,
    )


def build_recent(n_turns: int) -> list[TimelineEntry]:
    out: list[TimelineEntry] = []
    for i in range(n_turns):
        role = "user" if i % 2 == 0 else "ai"
        out.append(TimelineEntry(
            entry_id=f"t-{i}",
            profile_id="TEST",
            role=role,
            text=f"Turno {i}: frase di esempio di lunghezza media per il contesto.",
            timestamp=f"2026-10-13T10:{i:02d}:00Z",
        ))
    return out


def build_memories(n: int) -> list[Memory]:
    out: list[Memory] = []
    for i in range(n):
        out.append(Memory(
            memory_id=f"m-{i}",
            profile_id="TEST",
            memory_type="fact",
            concept=f"concept_{i}",
            text=f"Fatto numero {i} rilevante per il contesto conversazione.",
            created_at="2026-10-01T00:00:00Z",
        ))
    return out


def build_situations(n: int) -> list[Situation]:
    out: list[Situation] = []
    for i in range(n):
        out.append(Situation(
            situation_id=f"s-{i}",
            profile_id="TEST",
            entity=f"persona_{i}",
            title=f"Situazione aperta {i}",
            summary="Dettaglio situazione in corso rilevante per Ollenya.",
            created_at="2026-10-01T00:00:00Z",
        ))
    return out


# -----------------------------------------------------------------------------
# Ricostruzione del user_payload identica a server.py:15226-15284
# (percorso Home / _fast_pipeline_task).
# NON includiamo i rami opzionali (GPS/web_search_brief) perché nel caso
# base non si attivano. Sono annotati come "variante" nel README.
# -----------------------------------------------------------------------------
def build_user_payload(recent: list[TimelineEntry], user_text: str, lang: str = "it") -> str:
    parts: list[str] = []
    history_str = _format_history_for_llm(recent) if recent else ""
    if history_str:
        parts.append(f"STORICO RECENTE:\n{history_str}")
    parts.append(f"UTENTE: {user_text}")
    lang_reminder = {
        "it": "🇮🇹 Rispondi ESCLUSIVAMENTE in ITALIANO. Mai spagnolo. Mai inglese.",
        "en": "🇬🇧 Reply ONLY in ENGLISH. Never in another language.",
        "es": "🇪🇸 Responde SOLO en ESPAÑOL.",
        "fr": "🇫🇷 Réponds UNIQUEMENT en FRANÇAIS.",
        "de": "🇩🇪 Antworte AUSSCHLIESSLICH auf DEUTSCH.",
    }.get(lang, "Rispondi solo in italiano.")
    parts.append(lang_reminder)
    parts.append('Rispondi SOLO col JSON, "reply" come primo campo.')
    return "\n\n".join(parts)


def make_body(sys_prompt: str, user_payload: str) -> dict:
    """
    Struttura identica a server.py:15317-15349:
      - system = [{type:text, text:<...>, cache_control:{type:ephemeral}}]
      - messages = [{role:user, content:<...>}]
    Un singolo breakpoint di cache sul system block.
    """
    return {
        "model": MODEL,
        "max_tokens_output": MAX_TOKENS_OUTPUT,
        "request_body": {
            "system": [
                {
                    "type": "text",
                    "text": sys_prompt,
                    "cache_control": {"type": "ephemeral"},
                }
            ],
            "messages": [
                {"role": "user", "content": user_payload},
            ],
        },
    }


# -----------------------------------------------------------------------------
# Payload concreti da esportare
# -----------------------------------------------------------------------------
def write_payload(filename: str, label: str, note: str, body: dict) -> None:
    body["label"] = label
    body["note_cacheability"] = note
    out_path = OUT_DIR / filename
    with out_path.open("w", encoding="utf-8") as f:
        json.dump(body, f, ensure_ascii=False, indent=2)
    print(f"  wrote {out_path} ({out_path.stat().st_size:,} bytes)")


def main() -> None:
    print("Ollenya — export payload Home (dati fittizi, no IO esterno)")
    print(f"Output dir: {OUT_DIR}")
    print()

    profile = build_profile()

    # ---------- 01. minimo: solo profilo, nessuna cronologia ----------
    sp_min = _build_fast_system_prompt(
        profile, recent=[], memories=None,
        trial_state="active", situations=None,
    )
    up_min = build_user_payload(recent=[], user_text="Ciao.")
    write_payload(
        "01_minimo__profilo_e_1_turno.json",
        label="Home — minimo (profilo + 1 turno utente)",
        note=(
            "system contiene: identità, divieti, formato JSON, blocco temporale "
            "(dinamico al minuto), lingua. NESSUNA memoria, NESSUNA situazione, "
            "NESSUNO storico. user contiene solo 'UTENTE: Ciao.' + reminder lingua "
            "+ reminder JSON. Cache_control ephemeral sull'intero system. Il blocco "
            "temporale cambia ogni minuto → riduce cache hit reale."
        ),
        body=make_body(sp_min, up_min),
    )

    # ---------- 02. medio: 10 turni cronologia + 10 memorie ----------
    recent_10 = build_recent(10)
    sp_med = _build_fast_system_prompt(
        profile, recent=recent_10, memories=build_memories(10),
        trial_state="active", situations=None,
    )
    # In produzione la cronologia va NELL'user_payload (STORICO RECENTE),
    # non nel system. _build_fast_system_prompt riceve `recent` solo per
    # calcolare il blocco temporale dall'ultimo entry user.
    up_med = build_user_payload(
        recent=recent_10,
        user_text="Ho avuto una giornata difficile al lavoro, Ollenya.",
    )
    write_payload(
        "02_medio__10_turni_10_memorie.json",
        label="Home — medio (10 turni cronologia + 10 memorie)",
        note=(
            "system contiene: identità + 10 memorie + blocco temporale. "
            "user contiene: STORICO RECENTE con ultimi 6 turni "
            "(server.py:_format_history_for_llm clampa a -6) + 'UTENTE: ...' + "
            "reminder lingua + reminder JSON. Le memorie dentro il system block "
            "sono cacheable con lo stesso cache_control, MA cambiano quando "
            "l'utente aggiunge/rimuove fatti (invalida la cache)."
        ),
        body=make_body(sp_med, up_med),
    )

    # ---------- 03. realistico: completo ----------
    sp_full = _build_fast_system_prompt(
        profile,
        recent=recent_10,
        memories=build_memories(20),
        trial_state="active",
        situations=build_situations(3),
    )
    up_full = build_user_payload(
        recent=recent_10,
        user_text="Mi sento sopraffatto. Non so da che parte iniziare oggi.",
    )
    write_payload(
        "03_realistico__completo_con_user_text.json",
        label="Home — realistico (20 memorie, 3 situazioni, user text reale)",
        note=(
            "system contiene identità + 20 memorie + 3 situazioni + temporal_block. "
            "user contiene STORICO RECENTE (6 turni) + USER TEXT reale + reminder "
            "lingua + reminder JSON. Rappresenta il payload medio produzione dopo "
            "qualche giorno di utilizzo. Cache_control sempre singolo sul system; "
            "cache hit reale dipende dalla stabilità di memorie/situazioni/blocco "
            "temporale turno-turno."
        ),
        body=make_body(sp_full, up_full),
    )

    # ---------- README ----------
    readme = OUT_DIR / "_README.md"
    readme.write_text(
        """# Ollenya — payload Home esportati

File generati da `export_home_payloads.py` (import `server.py` solo in-memoria,
zero IO esterno). Ogni JSON contiene il **request body esatto** che
`_fast_pipeline_task` invia a Claude Haiku 4.5:

```json
{
  "model": "claude-haiku-4-5-20251001",
  "max_tokens_output": 320,
  "request_body": {
    "system":  [ { "type":"text", "text":"...", "cache_control":{"type":"ephemeral"} } ],
    "messages":[ { "role":"user", "content":"..." } ]
  },
  "label": "...",
  "note_cacheability": "..."
}
```

Dati fittizi — nessun campo è legato a utenti reali. Vedi
`measure_prompt_tokens_v3.py` per contare i token.

## Varianti NON incluse (rami opzionali)
- GPS iniettato nel user_payload (solo se la domanda è "dove sono/che tempo
  fa"). Aggiunge ~100-200 caratteri.
- Web search brief (solo se Tavily attivo e query real-time). Aggiunge
  tipicamente 400-800 token.
- Istruzioni "web-search disabled" (iniettate nel system quando
  l'utente ha disattivato Impostazioni → Ricerca Web).

Se servono, si possono generare con lo stesso export aggiungendo i
blocchi corrispondenti.
""",
        encoding="utf-8",
    )
    print(f"  wrote {readme}")
    print()
    print("done.")


if __name__ == "__main__":
    main()
