#!/usr/bin/env python3
"""
Ollenya — Misura token Claude Haiku 4.5 SU PAYLOAD REALE
=========================================================

Scopo: contare esattamente i token che il backend Ollenya invierebbe a
Claude Haiku 4.5 per la Home voce, includendo:
  1. Risposta principale (`_fast_pipeline_task`)
  2. Safety classifier (`_safety_llm_classify`) quando chiamato

GARANZIE DI SICUREZZA
---------------------
  • Zero generazione: usa SOLO `anthropic.beta.messages.count_tokens()`
    (endpoint utility GRATUITO di Anthropic, non consuma crediti).
  • Zero scritture DB.
  • Zero chiamate ElevenLabs / Universal Key / Deepgram.
  • Zero modifiche a configurazioni o codice del server.

OUTPUT
------
  • Breakdown dei componenti del prompt (istruzioni fisse, cronologia,
    memoria, situazioni, messaggio utente).
  • Conteggio token tiktoken (approssimazione open-source) VS Anthropic
    esatto (quando ANTHROPIC_API_KEY è configurata).
  • Esempio concreto (profilo + cronologia reali o fittizi) vs massimo
    teorico imposto dal codice.
  • Confronto costi: cache OFF / cache SEMPRE WRITE / cache REUSE.

PREREQUISITI
------------
  pip install anthropic tiktoken pymongo python-dotenv

CONFIGURAZIONE CHIAVE ANTHROPIC (RISERVATA)
-------------------------------------------
Non passare mai la chiave come argomento `python3 ... --key=...` (resta
nella history della shell).

Metodo consigliato:
  1. Crea un file `~/.anthropic_key` con permessi 600:
       touch ~/.anthropic_key && chmod 600 ~/.anthropic_key
  2. Incolla la chiave `sk-ant-...` nel file (una sola riga).
  3. Esegui lo script:
       export ANTHROPIC_API_KEY="$(cat ~/.anthropic_key)"
       python3 /app/backend/scripts/measure_prompt_tokens_v2.py
       unset ANTHROPIC_API_KEY

ESECUZIONE SENZA CHIAVE ANTHROPIC
---------------------------------
Lo script funziona anche senza ANTHROPIC_API_KEY: produce solo i
conteggi tiktoken (approssimati ±5-10% rispetto a Claude). Utile per
ottenere un ordine di grandezza senza creare l'account.

Versione: 2.0 (2026-10-13)
"""
from __future__ import annotations
import os
import sys
import json

sys.path.insert(0, "/app/backend")

# -----------------------------------------------------------------------------
# Config ambiente minimo
# -----------------------------------------------------------------------------
os.environ.setdefault("MONGO_URL", "mongodb://localhost:27017")
os.environ.setdefault("DB_NAME", "test_database")

ANTHROPIC_KEY_PRESENT = bool(os.environ.get("ANTHROPIC_API_KEY", "").startswith("sk-ant-"))

try:
    import tiktoken
    _TIKTOKEN_ENC = tiktoken.get_encoding("cl100k_base")
except ImportError:
    print("ERRORE: tiktoken non installato. pip install tiktoken", file=sys.stderr)
    sys.exit(1)

try:
    import anthropic
except ImportError:
    print("WARN: pacchetto anthropic non installato. Solo tiktoken attivo.", file=sys.stderr)
    anthropic = None

try:
    import server as srv
except Exception as e:
    print(f"ERRORE import server.py: {e}", file=sys.stderr)
    sys.exit(1)


# -----------------------------------------------------------------------------
# PROFILO + CONTESTO PER MISURA
# -----------------------------------------------------------------------------
def build_test_profile():
    return srv.Profile(
        profile_id="TEST-" + "a" * 32, name="MARIO", gender="m",
        language="it", tone_preference="warm",
        voice_id="POuqf18evoXOKIqV2Px7",
        subscription_tier="monthly", onboarded=True,
    )

def build_test_recent(n_turns: int):
    recent = []
    for i in range(n_turns):
        role = "user" if i % 2 == 0 else "ai"
        text = f"Turno {i}: frase di esempio di lunghezza media per il contesto."
        recent.append(srv.TimelineEntry(
            entry_id=f"t-{i}", profile_id="TEST", role=role,
            text=text, timestamp=f"2026-10-13T10:{i:02d}:00Z",
        ))
    return recent

def build_test_memories(n: int):
    mems = []
    for i in range(n):
        mems.append(srv.Memory(
            memory_id=f"m-{i}", profile_id="TEST", memory_type="fact",
            concept=f"concept_{i}",
            text=f"Fatto numero {i} rilevante per il contesto conversazione.",
            created_at="2026-10-01T00:00:00Z",
        ))
    return mems

def build_test_situations(n: int):
    sits = []
    for i in range(n):
        sits.append(srv.Situation(
            situation_id=f"s-{i}", profile_id="TEST", entity=f"persona_{i}",
            title=f"Situazione aperta {i}",
            summary=f"Dettaglio situazione in corso rilevante per Ollenya.",
            created_at="2026-10-01T00:00:00Z",
        ))
    return sits


# -----------------------------------------------------------------------------
# TOKEN COUNTERS
# -----------------------------------------------------------------------------
def count_tiktoken(text: str) -> int:
    return len(_TIKTOKEN_ENC.encode(text))

def count_anthropic(system_text: str, user_text: str = "ciao, come stai?") -> int | None:
    """Conteggio esatto Claude via API gratuita Anthropic.
    Fallisce silente se chiave non presente."""
    if not ANTHROPIC_KEY_PRESENT or anthropic is None:
        return None
    try:
        client = anthropic.Anthropic()
        result = client.beta.messages.count_tokens(
            model="claude-haiku-4-5-20251001",
            system=[{"type": "text", "text": system_text,
                     "cache_control": {"type": "ephemeral"}}],
            messages=[{"role": "user", "content": user_text}],
        )
        return result.input_tokens
    except Exception as e:
        print(f"[anthropic count_tokens] errore: {e}", file=sys.stderr)
        return None


# -----------------------------------------------------------------------------
# ANALISI
# -----------------------------------------------------------------------------
def analyze_fast_prompt_components():
    """Breakdown del prompt Home voce per componente."""
    profile = build_test_profile()

    # Prompt minimo (solo profilo, zero contesto)
    p0 = srv._build_fast_system_prompt(profile, [], memories=None,
                                       trial_state="active", situations=None)

    # Aggiunta cronologia (10 turni)
    p1 = srv._build_fast_system_prompt(profile, build_test_recent(10),
                                       memories=None, trial_state="active",
                                       situations=None)

    # Aggiunta memorie (10 fatti)
    p2 = srv._build_fast_system_prompt(profile, build_test_recent(10),
                                       memories=build_test_memories(10),
                                       trial_state="active", situations=None)

    # Aggiunta situazioni (3 eventi)
    p3 = srv._build_fast_system_prompt(profile, build_test_recent(10),
                                       memories=build_test_memories(10),
                                       trial_state="active",
                                       situations=build_test_situations(3))

    return {
        "statico (solo profilo)":         p0,
        "+ cronologia 10 turni":          p1,
        "+ memorie 10 fatti":             p2,
        "+ situazioni 3 eventi (COMPLETO)": p3,
    }


def analyze_classifier_prompt():
    """Prompt classifier estratto dal codice server.py:6779-6797."""
    return (
        "Sei un classificatore di sicurezza. Ricevi un messaggio in italiano. "
        "Devi rispondere SOLO con JSON nel formato: "
        '{"risk_level": 0-3, "category": "suicide|selfharm|domestic|minor|general_crisis|none"}.\n'
        "Scala risk_level:\n"
        "  0 = nessun rischio (conversazione normale)\n"
        "  1 = preoccupazione lieve (stanchezza, tristezza generica, sfogo)\n"
        "  2 = rischio moderato (ideazione passiva, isolamento grave, abuso passato)\n"
        "  3 = rischio acuto (ideazione suicidaria attiva, autolesionismo in atto, "
        "abuso in corso, minore in pericolo immediato)\n"
        "Categorie:\n"
        "  - suicide: pensieri di morte, suicidio, voler sparire definitivamente\n"
        "  - selfharm: autolesionismo, tagliarsi, ferirsi\n"
        "  - domestic: violenza domestica, partner violento, abuso in famiglia\n"
        "  - minor: minore (bambino/adolescente) in pericolo o abusato\n"
        "  - general_crisis: altre crisi acute (psicosi acuta, attacco panico grave)\n"
        "  - none: tutto il resto\n"
        "ATTENZIONE: espressioni colloquiali NON sono rischi (es. 'muoio di fame', "
        "'mi ammazzo di lavoro', 'che noia mortale'). Concentrati sull'intento reale."
    )


# -----------------------------------------------------------------------------
# COST COMPARISON
# -----------------------------------------------------------------------------
PRICE_INPUT_PER_1M = 1.00
PRICE_OUTPUT_PER_1M = 5.00
PRICE_CACHE_WRITE_5M_PER_1M = 1.25
PRICE_CACHE_HIT_PER_1M = 0.10

def cost_scenario(static_tokens, dynamic_tokens, output_tokens, scenario):
    """
    scenario:
      - "no_cache": tutto input al prezzo pieno
      - "cache_write_every_turn": paga cache_write ad ogni turno (worst-case cache)
      - "cache_reuse": prima scrittura, poi letture cache a $0.10/1M
    """
    if scenario == "no_cache":
        in_cost = (static_tokens + dynamic_tokens) * PRICE_INPUT_PER_1M / 1_000_000
    elif scenario == "cache_write_every_turn":
        in_cost = (static_tokens * PRICE_CACHE_WRITE_5M_PER_1M +
                   dynamic_tokens * PRICE_INPUT_PER_1M) / 1_000_000
    elif scenario == "cache_reuse":
        in_cost = (static_tokens * PRICE_CACHE_HIT_PER_1M +
                   dynamic_tokens * PRICE_INPUT_PER_1M) / 1_000_000
    out_cost = output_tokens * PRICE_OUTPUT_PER_1M / 1_000_000
    return in_cost + out_cost


# -----------------------------------------------------------------------------
# MAIN
# -----------------------------------------------------------------------------
def main():
    print("=" * 72)
    print("Ollenya — Misura token Claude Haiku 4.5 (SOLO conteggio, zero costo)")
    print("=" * 72)
    print()
    if ANTHROPIC_KEY_PRESENT:
        print("ANTHROPIC_API_KEY rilevata → userò anche il tokenizer esatto Claude.")
    else:
        print("ANTHROPIC_API_KEY non configurata → solo tiktoken (±5-10% stima).")
    print()

    # ========================================================================
    # 1. HOME VOCE — breakdown componenti
    # ========================================================================
    print("### 1. HOME VOCE — breakdown componenti prompt system")
    print()
    components = analyze_fast_prompt_components()
    prev_tok_tt = 0
    prev_tok_an = 0
    rows = []
    for name, prompt in components.items():
        chars = len(prompt)
        tok_tt = count_tiktoken(prompt)
        tok_an = count_anthropic(prompt) if ANTHROPIC_KEY_PRESENT else None
        delta_tt = tok_tt - prev_tok_tt
        delta_an = (tok_an - prev_tok_an) if (tok_an is not None and prev_tok_an) else None
        rows.append({
            "layer": name, "chars": chars,
            "tokens_tiktoken": tok_tt, "delta_tt": delta_tt,
            "tokens_anthropic": tok_an, "delta_an": delta_an,
        })
        prev_tok_tt = tok_tt
        if tok_an is not None:
            prev_tok_an = tok_an

    print(f"  {'Componente':<40} {'Caratteri':>10} {'tiktoken':>10} {'delta':>8}  {'Anthropic':>10} {'delta':>8}")
    print(f"  {'-'*40} {'-'*10} {'-'*10} {'-'*8}  {'-'*10} {'-'*8}")
    for r in rows:
        an_str = f"{r['tokens_anthropic']:>10,}" if r['tokens_anthropic'] else f"{'(n/d)':>10}"
        dan_str = f"{r['delta_an']:>+8,}" if r['delta_an'] is not None else f"{'(n/d)':>8}"
        print(f"  {r['layer']:<40} {r['chars']:>10,} {r['tokens_tiktoken']:>10,} {r['delta_tt']:>+8,}  {an_str} {dan_str}")
    print()

    # ========================================================================
    # 2. MASSIMO TEORICO vs ESEMPIO CONCRETO
    # ========================================================================
    print("### 2. Massimi imposti dal codice vs esempio concreto")
    print()
    print("  Massimi hardcoded nel codice (server.py):")
    print("    - Prompt system statico: SEMPRE presente (hardcoded)")
    print("    - Cronologia: ultimi N turni (N non limitato esplicitamente da max,")
    print("      ma il backend tipicamente iniezione ~10 turni → verificare N reale)")
    print("    - Memorie: fino a 20 fatti recenti (verificabile da _retrieve_memories)")
    print("    - Situazioni: tutte quelle 'aperte' (count variabile)")
    print("    - User text: non troncato nel path Home (al classifier: [:1500 car])")
    print("    - max_tokens output reply: 320 (server.py:15373)")
    print("    - max_tokens output classifier: 80 (server.py:6803)")
    print()

    # ========================================================================
    # 3. CLASSIFIER
    # ========================================================================
    print("### 3. CLASSIFIER (chiamato condizionalmente)")
    print()
    cls = analyze_classifier_prompt()
    cls_tok_tt = count_tiktoken(cls)
    cls_tok_an = count_anthropic(cls, user_text="Esempio messaggio utente")
    user_1500 = "a" * 1500  # max user text per classifier
    user_1500_tt = count_tiktoken(user_1500)
    print(f"  System prompt classifier:  {len(cls):>6,} car   {cls_tok_tt:>5,} tiktoken   "
          f"{'(n/d)' if cls_tok_an is None else f'{cls_tok_an:,} Anthropic'}")
    print(f"  User text max (1500 car):  1,500 car   {user_1500_tt:>5,} tiktoken")
    print(f"  max_tokens output:         80 (hardcoded)")
    print(f"  Trigger: regex strato-1 non ha matchato E skip_llm=False")
    print()

    # ========================================================================
    # 4. CACHEABLE STATIC vs DYNAMIC
    # ========================================================================
    print("### 4. Parti cacheable (riutilizzabili) vs dinamiche (ricalcolate ogni turno)")
    print()
    p_static = srv._build_fast_system_prompt(build_test_profile(), [],
                                             memories=None, trial_state="active",
                                             situations=None)
    p_full = srv._build_fast_system_prompt(build_test_profile(),
                                           build_test_recent(10),
                                           memories=build_test_memories(10),
                                           trial_state="active",
                                           situations=build_test_situations(3))
    static_tok = count_tiktoken(p_static)
    full_tok = count_tiktoken(p_full)
    dynamic_tok = full_tok - static_tok
    print(f"  Statico (cacheable con cache_control ephemeral):")
    print(f"    - Istruzioni comportamentali, regole prompt, tono, divieti, voce")
    print(f"    - Esempi mini-ancora, formato output JSON")
    print(f"    - Token: ~{static_tok:,}")
    print(f"  Dinamico (NON cacheable, cambia ogni turno):")
    print(f"    - Cronologia ultimi turni")
    print(f"    - Memorie fatti recenti")
    print(f"    - Situazioni aperte")
    print(f"    - Trial state injection")
    print(f"    - Token (esempio con 10 turni + 10 mem + 3 sit): ~{dynamic_tok:,}")
    print()

    # ========================================================================
    # 5. CONFRONTO COSTI — 3 SCENARI CACHE
    # ========================================================================
    print("### 5. Costo per turno Home — 3 scenari cache (NO ipotesi hit-rate)")
    print()
    output_tok = 320  # max hardcoded
    print(f"  Parametri: static={static_tok:,} dyn={dynamic_tok:,} out={output_tok} (max)")
    print()
    for sc_name, sc_label in [
        ("no_cache", "A) Cache DISATTIVATA (tetto prudenziale)"),
        ("cache_write_every_turn", "B) Cache SEMPRE RISCRITTA (worst-case cache attiva)"),
        ("cache_reuse", "C) Cache RIUTILIZZATA (best-case cache hit)"),
    ]:
        cost = cost_scenario(static_tok, dynamic_tok, output_tok, sc_name)
        print(f"  {sc_label}: ${cost:.6f}/turno")
    print()
    print("  Nota: scenari B e C sono i DUE ESTREMI della cache. In produzione")
    print("        il costo medio reale sta tra B e C in proporzione al hit rate")
    print("        reale, che NON è misurato.")
    print()

    # ========================================================================
    # 6. CONFRONTO CON CLASSIFIER AGGIUNTO
    # ========================================================================
    print("### 6. Costo per turno INCLUSO safety classifier")
    print()
    cls_full_tok = cls_tok_tt + 400  # system + user medio
    cls_cost = (cls_full_tok * PRICE_INPUT_PER_1M + 80 * PRICE_OUTPUT_PER_1M) / 1_000_000
    print(f"  Classifier (no cache applicabile al prompt piccolo):")
    print(f"    input={cls_full_tok:,} tok   output=80 tok   costo=${cls_cost:.6f}/chiamata")
    print()
    print(f"  Turno Home COMPLETO (reply + classifier quando triggered):")
    for sc_name, sc_label in [
        ("no_cache", "A) Cache OFF"),
        ("cache_write_every_turn", "B) Cache sempre write"),
        ("cache_reuse", "C) Cache reuse"),
    ]:
        reply_cost = cost_scenario(static_tok, dynamic_tok, output_tok, sc_name)
        total = reply_cost + cls_cost
        print(f"    {sc_label}: ${total:.6f}/turno (reply ${reply_cost:.6f} + classifier ${cls_cost:.6f})")
    print()
    print("=" * 72)
    print("FINE MISURA. Zero chiamate a pagamento effettuate.")
    print("=" * 72)


if __name__ == "__main__":
    main()
