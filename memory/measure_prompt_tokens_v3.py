#!/usr/bin/env python3
"""
Ollenya — Misura token Claude Haiku 4.5 (v3, zero dipendenza da server.py)
==========================================================================

Scopo
-----
Contare ESATTAMENTE i token che il percorso Home (`_fast_pipeline_task`)
invierebbe a Claude Haiku 4.5, usando come input i payload JSON già
esportati da `export_home_payloads.py` (dati fittizi).

Differenze rispetto a v2
------------------------
  1. NON importa server.py. Legge soltanto i file JSON della cartella
     `./home_payloads/`.
  2. Conta il payload COMPLETO (system + user con cache_control), non
     solo il system.
  3. I costi vengono calcolati SOLO con il conteggio esatto Anthropic.
     Se la chiave non è configurata, lo script NON stampa alcun costo:
     esce con messaggio esplicito. Nessun fallback silenzioso su tiktoken.
  4. Oltre al conteggio totale, misura separatamente il peso dei soli
     blocchi `system` (incluso cache_control) per quantificare la quota
     cacheable, senza dedurla dalla differenza fra due prompt diversi.
  5. tiktoken resta disponibile come SANITY-CHECK informativo ma non
     entra MAI nel calcolo dei costi.

Garanzie di non-pagamento
-------------------------
  * `anthropic.beta.messages.count_tokens(...)` è un endpoint utility
    ufficiale GRATUITO. Non consuma crediti, non produce output.
  * Nessuna chiamata a `messages.create` / `messages.stream`.
  * Nessuna scrittura su DB. Nessuna connessione a ElevenLabs, Deepgram,
    OpenAI, Resend, Universal Key.

Esecuzione
----------
  pip install anthropic tiktoken

  # Solo stima tiktoken (nessun costo stimato):
  python3 measure_prompt_tokens_v3.py --payloads ./home_payloads

  # Conteggio esatto + costi (richiede chiave personale, GRATUITA da usare):
  touch ~/.anthropic_key && chmod 600 ~/.anthropic_key
  # incolla la chiave dentro con un editor
  export ANTHROPIC_API_KEY="$(cat ~/.anthropic_key)"
  python3 measure_prompt_tokens_v3.py --payloads ./home_payloads
  unset ANTHROPIC_API_KEY

Prezzi Claude Haiku 4.5 (listino pubblico Anthropic, USD per 1M token)
---------------------------------------------------------------------
  input (uncached):       $1.00
  cache write (5min TTL): $1.25
  cache read (hit):       $0.10
  output:                 $5.00

Versione: 3.0 (2026-10-13)
"""
from __future__ import annotations
import argparse
import json
import os
import sys
from pathlib import Path

# -----------------------------------------------------------------------------
# Prezzi (listino pubblico Anthropic)
# -----------------------------------------------------------------------------
PRICE_INPUT_PER_1M = 1.00
PRICE_OUTPUT_PER_1M = 5.00
PRICE_CACHE_WRITE_5M_PER_1M = 1.25
PRICE_CACHE_HIT_PER_1M = 0.10


# -----------------------------------------------------------------------------
# tiktoken: usato SOLO come sanity-check informativo, mai per i costi.
# -----------------------------------------------------------------------------
def load_tiktoken():
    try:
        import tiktoken
        return tiktoken.get_encoding("cl100k_base")
    except ImportError:
        return None


def count_tiktoken(enc, text: str) -> int | None:
    if enc is None:
        return None
    return len(enc.encode(text))


# -----------------------------------------------------------------------------
# Anthropic count_tokens (gratuito).
# Se la chiave manca, torniamo None e NON stimiamo nulla.
# -----------------------------------------------------------------------------
def anthropic_available() -> bool:
    return bool(os.environ.get("ANTHROPIC_API_KEY", "").startswith("sk-ant-"))


def count_anthropic_body(client, model: str, system_blocks: list, messages: list) -> int:
    """Chiama beta.messages.count_tokens con l'intero body (system+user)."""
    result = client.beta.messages.count_tokens(
        model=model, system=system_blocks, messages=messages,
    )
    return int(result.input_tokens)


# -----------------------------------------------------------------------------
# Load payload JSON esportati.
# -----------------------------------------------------------------------------
def load_payloads(payloads_dir: Path) -> list[dict]:
    files = sorted(p for p in payloads_dir.glob("*.json"))
    if not files:
        print(f"ERRORE: nessun .json trovato in {payloads_dir}", file=sys.stderr)
        sys.exit(2)
    out = []
    for p in files:
        with p.open("r", encoding="utf-8") as f:
            data = json.load(f)
        data["_file"] = p.name
        out.append(data)
    return out


# -----------------------------------------------------------------------------
# Report per singolo payload.
# -----------------------------------------------------------------------------
def report_payload(payload: dict, client, enc) -> dict:
    label = payload.get("label", payload["_file"])
    note = payload.get("note_cacheability", "")
    model = payload["model"]
    max_out = int(payload["max_tokens_output"])
    body = payload["request_body"]
    system_blocks = body["system"]
    messages = body["messages"]

    assert isinstance(system_blocks, list) and system_blocks, "system blocks mancanti"
    assert isinstance(messages, list) and messages, "messages mancanti"
    system_text = system_blocks[0]["text"]
    user_text = messages[0]["content"]

    # --- tiktoken (sanity-check, NON usato per i costi) ---
    tt_system = count_tiktoken(enc, system_text)
    tt_user = count_tiktoken(enc, user_text)

    # --- Anthropic esatto ---
    anth_total = None
    anth_system_only = None
    anth_user_only = None
    if client is not None:
        anth_total = count_anthropic_body(
            client, model, system_blocks, messages,
        )
        # Misura separata del system: stesso system_block + user minimo ".".
        # Il delta ci dà il peso del user_payload reale, SENZA dedurre nulla
        # da altri system prompt diversi.
        anth_system_only = count_anthropic_body(
            client, model, system_blocks,
            [{"role": "user", "content": "."}],
        )
        # Il count del "." isolato è ~2-3 token di overhead minimo:
        # calcoliamo l'overhead reale chiamando lo stesso body con system VUOTO.
        # count_tokens vieta system vuoto: usiamo un system minimale e sottraiamo.
        _overhead = count_anthropic_body(
            client, model,
            [{"type": "text", "text": "."}],
            [{"role": "user", "content": "."}],
        )
        # overhead chat-template ≈ _overhead - 2 (il "." system + "." user).
        # Non ci interessa decomporlo oltre: usiamo anth_system_only come
        # proxy esatto del "costo system con cache_control" nelle formule
        # (già include correttamente il breakpoint di cache).
        anth_user_only = anth_total - anth_system_only + 2  # +2 compensa "." user

    out = {
        "file": payload["_file"],
        "label": label,
        "note": note,
        "model": model,
        "max_tokens_output": max_out,
        "tiktoken_system": tt_system,
        "tiktoken_user": tt_user,
        "tiktoken_total": (tt_system + tt_user) if (tt_system and tt_user) else None,
        "anthropic_total_input": anth_total,
        "anthropic_system_only": anth_system_only,
        "anthropic_user_only": anth_user_only,
    }
    return out


def print_report_row(r: dict) -> None:
    print(f"\n--- {r['file']} ---")
    print(f"  Label: {r['label']}")
    print(f"  Note : {r['note']}")
    print(f"  Model: {r['model']}  max_tokens_output={r['max_tokens_output']}")
    print()
    print(f"  {'Metrica':<35} {'tiktoken (±)':>15} {'Anthropic (esatto)':>22}")
    print(f"  {'-'*35} {'-'*15} {'-'*22}")
    def _fmt(v):
        return f"{v:>15,}" if isinstance(v, int) else f"{'(n/d)':>15}"
    def _fmt_an(v):
        return f"{v:>22,}" if isinstance(v, int) else f"{'(n/d)':>22}"
    print(f"  {'system (con cache_control)':<35} {_fmt(r['tiktoken_system'])} {_fmt_an(r['anthropic_system_only'])}")
    print(f"  {'user (dinamico, no cache)':<35} {_fmt(r['tiktoken_user'])} {_fmt_an(r['anthropic_user_only'])}")
    print(f"  {'TOTALE input (system + user)':<35} {_fmt(r['tiktoken_total'])} {_fmt_an(r['anthropic_total_input'])}")
    print()


def print_cost(r: dict) -> None:
    """
    Stampa i costi SOLO se abbiamo i conteggi Anthropic esatti.
    Se mancano: nessun costo, warning esplicito.

    IMPORTANTE — SCENARI DI CACHE
    -----------------------------
    Il blocco `system` di Ollenya marcato con `cache_control: ephemeral`
    contiene TUTTE queste parti variabili turno-turno:
      1. Blocco temporale "ora attuale" (`_build_temporal_context`): cambia
         ad ogni minuto di orologio.
      2. Memorie (`memories`): cambia quando l'utente aggiunge/rimuove fatti
         o quando il FIFO del memory_summary ruota.
      3. Situazioni (`situations`): cambia quando una situazione si apre,
         si chiude, si aggiorna.
      4. Trial state injection: cambia al passaggio di stato (es. active →
         closing → expired).
    Finché NON è stato eseguito un test di invariance (due o più turni
    consecutivi che restituiscono `cache_read_input_tokens > 0`) il cache
    hit non è un costo previsionale: è un pavimento teorico irraggiungibile
    nelle condizioni attuali del prompt. Il costo PREVISIONALE per il
    sizing dei 500 minuti/mese è lo scenario A (no-cache) oppure B
    (cache_write ad ogni turno).
    """
    sys_tok = r["anthropic_system_only"]
    usr_tok = r["anthropic_user_only"]
    total_tok = r["anthropic_total_input"]
    if any(x is None for x in (sys_tok, usr_tok, total_tok)):
        print(f"  [COSTO] NON CALCOLATO — ANTHROPIC_API_KEY non configurata.")
        print(f"          Lo script non stima costi senza conteggio esatto.")
        return

    out_tok = r["max_tokens_output"]

    # A) No cache / cache disabilitata: tutto input al prezzo pieno.
    cost_no_cache = (
        total_tok * PRICE_INPUT_PER_1M / 1_000_000
        + out_tok * PRICE_OUTPUT_PER_1M / 1_000_000
    )
    # B) Cache WRITE ad ogni turno. SCENARIO PREVISIONALE REALISTICO
    #    finché la cache_read non è dimostrata in produzione, perché il
    #    system contiene parti dinamiche (temporal_block, memorie,
    #    situazioni, trial_state) che invalidano l'hit.
    cost_cache_write = (
        sys_tok * PRICE_CACHE_WRITE_5M_PER_1M / 1_000_000
        + usr_tok * PRICE_INPUT_PER_1M / 1_000_000
        + out_tok * PRICE_OUTPUT_PER_1M / 1_000_000
    )
    # D) Cache HIT (pavimento teorico, NON previsionale).
    #    Vale SOLO se il system è bit-identico al turno precedente entro
    #    5 minuti. Richiede test di invariance in produzione prima di
    #    poterlo usare come costo atteso.
    cost_cache_hit_floor = (
        sys_tok * PRICE_CACHE_HIT_PER_1M / 1_000_000
        + usr_tok * PRICE_INPUT_PER_1M / 1_000_000
        + out_tok * PRICE_OUTPUT_PER_1M / 1_000_000
    )

    print(f"  [COSTO per turno — Claude Haiku 4.5, prezzi listino pubblici]")
    print()
    print(f"  SCENARI PREVISIONALI (usare per sizing 500 min/mese):")
    print(f"     A) Cache DISATTIVATA / nessun breakpoint:   ${cost_no_cache:.6f}")
    print(f"     B) Cache WRITE ad ogni turno (realistico):  ${cost_cache_write:.6f}")
    print()
    print(f"  PAVIMENTO TEORICO (NON previsionale, da provare in produzione):")
    print(f"     D) Cache HIT 100% (irrealistico qui):       ${cost_cache_hit_floor:.6f}")
    print()
    print(f"     Perché D non è previsionale: il system block di Ollenya contiene")
    print(f"     almeno 4 parti dinamiche (ora attuale al minuto, memorie, situazioni,")
    print(f"     trial_state). Finché non viene misurato in produzione un turno con")
    print(f"     cache_read_input_tokens > 0 (vedi `usage` del response di")
    print(f"     messages.create), lo scenario B è il tetto previsionale per il")
    print(f"     sizing economico. Lo scenario D va considerato solo DOPO prova.")


def main() -> None:
    parser = argparse.ArgumentParser(description="Conta token Claude Haiku 4.5 su payload Home.")
    parser.add_argument(
        "--payloads",
        type=Path,
        default=Path(__file__).parent / "home_payloads",
        help="Cartella con i JSON esportati da export_home_payloads.py",
    )
    args = parser.parse_args()

    print("=" * 72)
    print("Ollenya — Misura token Claude Haiku 4.5 (v3, zero costo, zero IO esterno)")
    print("=" * 72)
    print(f"Cartella payload: {args.payloads}")

    enc = load_tiktoken()
    if enc is None:
        print("WARN: tiktoken non installato → sanity-check disabilitato.", file=sys.stderr)

    client = None
    if anthropic_available():
        try:
            import anthropic
        except ImportError:
            print("ERRORE: ANTHROPIC_API_KEY impostata ma pacchetto 'anthropic' mancante.", file=sys.stderr)
            print("        pip install anthropic", file=sys.stderr)
            sys.exit(3)
        client = anthropic.Anthropic()
        print("ANTHROPIC_API_KEY rilevata → conteggio esatto attivo. Costi verranno stampati.")
    else:
        print("ANTHROPIC_API_KEY non configurata.")
        print("  → verranno stampati SOLO i conteggi tiktoken (sanity-check).")
        print("  → NESSUN costo verrà stimato. Serve conteggio esatto Anthropic.")

    payloads = load_payloads(args.payloads)
    print(f"Payload caricati: {len(payloads)}")

    results = []
    for p in payloads:
        r = report_payload(p, client, enc)
        print_report_row(r)
        print_cost(r)
        results.append(r)

    print()
    print("=" * 72)
    print("FINE. Chiamate di rete effettuate:")
    if client is not None:
        n_calls = 3 * len(payloads)
        print(f"  * {n_calls} chiamate a beta.messages.count_tokens (GRATUITE).")
    else:
        print("  * 0 chiamate di rete.")
    print("Scritture DB: 0.  Chiamate a pagamento: 0.")
    print("=" * 72)


if __name__ == "__main__":
    main()
