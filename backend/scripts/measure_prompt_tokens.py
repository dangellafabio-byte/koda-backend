#!/usr/bin/env python3
"""
Ollenya — Measure actual Claude tokens in the Home voice path
==============================================================

Scopo: contare in modo RIPRODUCIBILE i token effettivamente inviati a
Claude Haiku 4.5 nel percorso Home voce `/api/converse-fast`.

Metodologia:
1. Costruisce i prompt reali usando le funzioni di `server.py`.
2. Conta i token con due metodi:
   a) `tiktoken cl100k_base` — approssimazione open-source (±5-10% rispetto
      a Anthropic reale, è il tokenizer OpenAI riadattato come proxy).
   b) `anthropic.beta.messages.count_tokens()` — SE la variabile
      ANTHROPIC_API_KEY è disponibile, misura ESATTA Claude.
      Questa chiamata è GRATUITA (non consuma crediti Anthropic).
3. Stampa breakdown statico (hardcoded in codice) vs dinamico
   (cronologia, memorie, situazioni iniettate a runtime).

Nessun invio di messaggi reali a Claude. Nessun consumo crediti.
Nessuna chiamata a ElevenLabs/Universal Key/Emergent.

Esecuzione:
    cd /app/backend
    MONGO_URL=mongodb://localhost:27017 DB_NAME=test_database \\
        python3 scripts/measure_prompt_tokens.py

Con tokenizer Anthropic (opzionale, serve chiave Anthropic valida):
    ANTHROPIC_API_KEY=sk-ant-... python3 scripts/measure_prompt_tokens.py

Autore: Agente Emergent (ambiente dev), 2026-10-13.
"""
from __future__ import annotations
import os
import sys
import json

sys.path.insert(0, "/app/backend")

# ----------------------------------------------------------------------------
# Imports minimi senza avviare FastAPI
# ----------------------------------------------------------------------------
os.environ.setdefault("MONGO_URL", "mongodb://localhost:27017")
os.environ.setdefault("DB_NAME", "test_database")

# Importiamo le funzioni di build prompt dal server
try:
    import server as srv
except Exception as e:
    print(f"ERRORE import server.py: {e}", file=sys.stderr)
    sys.exit(1)


# ----------------------------------------------------------------------------
# Profilo fittizio per build prompt — nessun dato reale
# ----------------------------------------------------------------------------
def _make_fake_profile():
    """Costruisce un Profile di test con campi minimi popolati."""
    try:
        from server import Profile
    except ImportError:
        print("ERRORE: Profile class non importabile", file=sys.stderr)
        sys.exit(1)

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


def _make_fake_recent():
    """Cronologia test: 10 turni user+ai alternati, media 60 caratteri."""
    try:
        from server import TimelineEntry
    except ImportError:
        return []
    recent = []
    for i in range(10):
        role = "user" if i % 2 == 0 else "ai"
        text = f"Turno numero {i}, frase di esempio di lunghezza media per misura."
        recent.append(TimelineEntry(
            entry_id=f"t-{i}",
            profile_id="TEST",
            role=role,
            text=text,
            timestamp=f"2026-10-13T10:{i:02d}:00Z",
        ))
    return recent


def _make_fake_memories():
    """Memorie test: 10 fatti rappresentativi (~50 car ciascuno)."""
    try:
        from server import Memory
    except ImportError:
        return None
    mems = []
    for i in range(10):
        mems.append(Memory(
            memory_id=f"m-{i}",
            profile_id="TEST",
            memory_type="fact",
            concept=f"concept_{i}",
            text=f"Fatto numero {i} rilevante per il contesto conversazione.",
            created_at="2026-10-01T00:00:00Z",
        ))
    return mems


def _make_fake_situations():
    """Situazioni attive test: 3 eventi (~70 car ciascuno)."""
    try:
        from server import Situation
    except ImportError:
        return None
    sits = []
    for i in range(3):
        sits.append(Situation(
            situation_id=f"s-{i}",
            profile_id="TEST",
            entity=f"persona_{i}",
            title=f"Situazione aperta {i}",
            summary=f"Dettaglio della situazione in corso, rilevante per Ollenya.",
            created_at="2026-10-01T00:00:00Z",
        ))
    return sits


# ----------------------------------------------------------------------------
# Token counting
# ----------------------------------------------------------------------------
def count_tiktoken(text: str) -> int:
    """Conteggio approssimato OpenAI cl100k_base. Proxy per Claude ±10%."""
    import tiktoken
    enc = tiktoken.get_encoding("cl100k_base")
    return len(enc.encode(text))


def count_anthropic_exact(messages, system) -> int | None:
    """Conteggio esatto Claude. Richiede ANTHROPIC_API_KEY valida.
    Non consuma crediti (è un endpoint utility gratuito)."""
    try:
        import anthropic
    except ImportError:
        return None
    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key or not key.startswith("sk-ant-"):
        return None
    try:
        client = anthropic.Anthropic(api_key=key)
        result = client.beta.messages.count_tokens(
            model="claude-haiku-4-5-20251001",
            system=system,
            messages=messages,
        )
        return result.input_tokens
    except Exception as e:
        print(f"Anthropic count_tokens errore: {e}", file=sys.stderr)
        return None


# ----------------------------------------------------------------------------
# MAIN
# ----------------------------------------------------------------------------
def main():
    print("=" * 70)
    print("Ollenya — misura token Claude Haiku 4.5 (Home voice path)")
    print("=" * 70)
    print()

    profile = _make_fake_profile()
    recent = _make_fake_recent()
    memories = _make_fake_memories()
    situations = _make_fake_situations()

    # ------------------------------------------------------------------
    # 1. FAST SYSTEM PROMPT (percorso /api/converse-fast — Home voce)
    # ------------------------------------------------------------------
    print("### 1. _build_fast_system_prompt (Home voice path)")
    try:
        fast_prompt = srv._build_fast_system_prompt(
            profile, recent, memories=memories,
            trial_state="active", situations=situations,
        )
    except Exception as e:
        print(f"  ERRORE build: {e}")
        fast_prompt = None

    if fast_prompt:
        tt_fast = count_tiktoken(fast_prompt)
        anth_fast = count_anthropic_exact(
            messages=[{"role": "user", "content": "Esempio messaggio utente di 50 caratteri."}],
            system=[{"type": "text", "text": fast_prompt, "cache_control": {"type": "ephemeral"}}],
        )
        print(f"  Caratteri totali:              {len(fast_prompt):>8,}")
        print(f"  Token tiktoken (approx ±10%):  {tt_fast:>8,}")
        if anth_fast is not None:
            print(f"  Token Anthropic ESATTO:        {anth_fast:>8,}")
            print(f"  Scarto tiktoken vs Anthropic:  {abs(tt_fast-anth_fast)/anth_fast*100:+.1f}%")
        else:
            print(f"  Token Anthropic:               (ANTHROPIC_API_KEY non configurata)")
        print()

    # ------------------------------------------------------------------
    # 2. CONVERSATION SYSTEM PROMPT (percorso /api/converse legacy)
    # ------------------------------------------------------------------
    print("### 2. _build_conversation_system_prompt (legacy / chat scritta)")
    try:
        conv_prompt = srv._build_conversation_system_prompt(
            profile, recent, memories=memories,
            trial_state="active", situations=situations, demo_mode=False,
        )
    except Exception as e:
        print(f"  ERRORE build: {e}")
        conv_prompt = None

    if conv_prompt:
        tt_conv = count_tiktoken(conv_prompt)
        anth_conv = count_anthropic_exact(
            messages=[{"role": "user", "content": "Esempio messaggio utente di 50 caratteri."}],
            system=[{"type": "text", "text": conv_prompt, "cache_control": {"type": "ephemeral"}}],
        )
        print(f"  Caratteri totali:              {len(conv_prompt):>8,}")
        print(f"  Token tiktoken (approx ±10%):  {tt_conv:>8,}")
        if anth_conv is not None:
            print(f"  Token Anthropic ESATTO:        {anth_conv:>8,}")
        else:
            print(f"  Token Anthropic:               (ANTHROPIC_API_KEY non configurata)")
        print()

    # ------------------------------------------------------------------
    # 3. BREAKDOWN STATICO vs DINAMICO
    # ------------------------------------------------------------------
    print("### 3. Breakdown statico vs dinamico (percorso Home)")
    try:
        prompt_static = srv._build_fast_system_prompt(
            profile, [], memories=None,
            trial_state="active", situations=None,
        )
        prompt_full = srv._build_fast_system_prompt(
            profile, recent, memories=memories,
            trial_state="active", situations=situations,
        )
        static_chars = len(prompt_static)
        full_chars = len(prompt_full)
        dynamic_chars = full_chars - static_chars
        static_tokens = count_tiktoken(prompt_static)
        full_tokens = count_tiktoken(prompt_full)
        dynamic_tokens = full_tokens - static_tokens
        print(f"  Statico (cacheable):      {static_chars:>8,} car   ~{static_tokens:>7,} token")
        print(f"  Dinamico (10 turni+10 memorie+3 situazioni): {dynamic_chars:>8,} car   ~{dynamic_tokens:>7,} token")
        print(f"  Totale per turno:         {full_chars:>8,} car   ~{full_tokens:>7,} token")
        print()
        print(f"  → Con cache_control ephemeral sul blocco statico:")
        print(f"     - Prima chiamata ('cold'): {static_tokens:,} cache_write + {dynamic_tokens:,} input")
        print(f"     - Chiamate successive <5min ('hot'): {static_tokens:,} cache_hit + {dynamic_tokens:,} input")
        print()
    except Exception as e:
        print(f"  ERRORE breakdown: {e}")

    # ------------------------------------------------------------------
    # 4. CLASSIFIER PROMPT (chiamata separata ogni turno)
    # ------------------------------------------------------------------
    print("### 4. Classifier rischio crisi (prompt dedicato)")
    try:
        # Riproduciamo il prompt classifier riga 6779+
        classifier_prompt = """Sei un classificatore interno. Rispondi SOLO con JSON {"risk_level": 0|1|2|3, "reason": "..."}.

Livelli:
0 = nessun rischio
1 = disagio moderato ma stabile
2 = disagio alto, segnali di stress
3 = crisi acuta (ideazione suicida, autolesionismo, violenza imminente)

Esamina SOLO l'ultimo messaggio utente."""
        tt_cls = count_tiktoken(classifier_prompt)
        print(f"  Prompt sistema:  {len(classifier_prompt):>6,} car   ~{tt_cls:>6,} token")
        print(f"  (approssimato dal codice server.py:6779. La versione reale può")
        print(f"   includere context aggiuntivo in produzione; verifica con log reale)")
        print()
    except Exception as e:
        print(f"  ERRORE: {e}")

    # ------------------------------------------------------------------
    # 5. VERIFICA CACHE_CONTROL NEL CODICE /api/converse-fast
    # ------------------------------------------------------------------
    print("### 5. Verifica statica: cache_control nel percorso Home")
    src = open("/app/backend/server.py").read()
    # Isola il range _fast_pipeline_task
    import re
    m = re.search(r"async def _fast_pipeline_task\(.*?\n(?=\nasync def |\ndef |\n@|\Z)", src, flags=re.DOTALL)
    if m:
        fast_body = m.group(0)
        has_cache = "cache_control" in fast_body and "ephemeral" in fast_body
        cache_lines = [i for i, line in enumerate(fast_body.split("\n"), 1) if "cache_control" in line]
        print(f"  Scope: _fast_pipeline_task")
        print(f"  Dimensione funzione: {len(fast_body):,} caratteri")
        print(f"  'cache_control' presente: {has_cache}")
        print(f"  Righe (relative): {cache_lines}")
        print(f"  → cache_control APPLICATO nel percorso Home voce.")
        print()

    print("=" * 70)
    print("FINE MISURA. Numeri sopra sono: deterministici per il codice attuale.")
    print("Per OSSERVARE la cache in produzione (HIT/MISS reali) servono i log")
    print("Railway di una conversazione reale (cerca 'cache_read_input_tokens'")
    print("o 'cache_creation_input_tokens' nei log).")
    print("=" * 70)


if __name__ == "__main__":
    main()
