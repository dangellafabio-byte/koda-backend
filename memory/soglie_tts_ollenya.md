# Soglie e percentuali TTS Ollenya — V3 / Turbo / Flash

**Data estrazione**: 12 ottobre 2026
**Fonte**: codice sorgente `/app/backend/server.py` + `/app/backend/tts_intensity_classifier.py`
**Validità**: valori hardcoded + default env, verificabili con grep sui file citati.

---

## 1. REGOLA FONDAMENTALE V3 — "V3 come eccezione vera"

Spec: Fabio, 2026-09-11.
File: `tts_intensity_classifier.py`, righe 214–227.

**V3 si usa SOLO se vale una di queste due condizioni:**

| Condizione | Trigger esatto |
|---|---|
| **Safety numbers** | Il testo di Ollenya contiene uno di: `1522`, `112`, `118`, `113`, `telefono azzurro` |
| **Intensity massima** | Il classifier assegna `intensity == 4` (crisi acuta: safety, SALIRE+concerned, urgenza) |

**In TUTTI gli altri casi → Turbo v2.5.**

Esempi espliciti di casi che **passano a Turbo** (non più V3 come era in v0):
- `mode ∈ {SALIRE, TENERE, ADMIT_FAULT}` senza intensity 4 → Turbo
- `tone == concerned` generico (senza SALIRE / senza safety) → Turbo
- Momento denso (`intensity == 3`) → Turbo
- Gioia forte, humility esplicita, warmth normale → Turbo

**Safe fallback**: se il testo è < 3 parole o il `tone` non è ancora disponibile → V3 (perché la decisione sarebbe poco informata).

---

## 2. PERCENTUALI MISURATE (offline, 716 turni reali)

Fonte: commento `server.py` righe 84–86 + `tts_intensity_classifier.py` righe 14–15.

### Classifier v0 (prima policy, 2026-08-14)

| Modello | % traffico |
|---|---|
| **V3** | **16,7 %** |
| **Turbo v2.5** | **83,3 %** |

Anti-regression 100% sui casi ovvi. Approvato da Fabio dopo ascolto A/B/C.

### Classifier v1 (policy restrittiva corrente, 2026-09-11)

Riduzione attesa misurata: **–55% / –60% sui turni V3** rispetto a v0.

| Modello | % traffico attesa |
|---|---|
| **V3** | **~6,7 % – 7,5 %** (16,7 % × 0,40 – 0,45) |
| **Turbo v2.5** | **~92,5 % – 93,3 %** |

Motivazione business (`tts_intensity_classifier.py` righe 224–227):
> V3 diventa un'ECCEZIONE strutturale. Il rischio "Ollenya suona diversa dopo che il budget V3 giornaliero è finito" si mitiga perché V3 parte già rara di default. Cost cut atteso: ~55-60% turni V3 → Turbo.

---

## 3. GATE GIORNALIERO V3 (tetto per utente, per giorno)

Fonte: `server.py` righe 4980–5100.
Variabile d'ambiente: `KODA_TTS_V3_DAILY_BUDGET`

| Parametro | Valore |
|---|---|
| **Budget V3 default** | **10 turni V3 / giorno / utente** |
| Reset | Cambio data UTC (mezzanotte UTC) |
| Oltre il budget | Downgrade silente a `eleven_turbo_v2_5` (nessun messaggio utente) |
| Grazia sul turno in corso | La decisione presa al chunk 0 vale per i chunk successivi (coerenza timbrica, no cambio mid-turno) |
| Istogramma intensity tracciato | Array `[int0, int1, int2, int3, int4]` giornaliero per telemetria |

**Comportamento combinato (gate + classifier)**:
1. Classifier dice V3 (perché intensity=4 o safety) →
2. Se `v3_turns_used_today < 10` → V3 passa, incrementa contatore
3. Se `v3_turns_used_today >= 10` → **downgrade a Turbo**, incrementa `downgrades_paced`

Log telemetria server: `[OLLENYA_PACING] downgrade v3→turbo`.

---

## 4. FLASH v2.5 — Dove si usa

Fonte: `server.py` righe 11090–11093, 11425–11426.

Flash v2.5 **non ha gate dedicato né quota**. Si usa:
- **Default per ogni messaggio senza audio tag** (`[warmly]`, `[softly]`, `[thoughtful]`, `[sospira]`, `[ride]`)
- Fallback automatico quando V3 fallisce (riga 11139 / 11449)

Logica di scelta (fast pipeline, converse endpoint, classifier **non attivo** per default):
```
if testo contiene audio tag → eleven_v3
else                         → eleven_flash_v2_5
```

Il classifier intensity (sezioni 1-3) **è dietro feature flag** `KODA_TTS_CLASSIFIER_ENABLED` (default OFF, riga 88). Oggi, in produzione, Flash è il modello dominante perché:
- Audio tag MAX 1 per reply (prompt rule system riga 3242)
- La maggior parte delle reply non ha tag

### Mix produzione reale ATTESO (senza classifier attivo)

| Modello | % traffico stimata |
|---|---|
| **Flash v2.5** | **85 – 92 %** |
| **V3** | **8 – 15 %** (solo turni con audio tag) |
| **Turbo v2.5** | ~0 % (solo fallback catena) |

**Da misurare con audit reale**: export CSV ElevenLabs → verificare se Flash è davvero >85% dei caratteri fatturati.

---

## 5. SOGLIE MENSILI MINUTI TTS (per utente, non per modello)

Fonte: `server.py` righe 4636–4664.

### Budget base mensile (tutti i tier pagati)

```
TIER_MONTHLY_BUDGET = {
    "monthly":   500 min,
    "bimonthly": 500 min,
    "annual":    500 min,
}
```

### Pool massimo di carryover (minuti conservabili dal mese precedente)

```
TIER_POOL_MAX = {
    "monthly":   0 min      (0 slot — nessun carryover)
    "bimonthly": 50 min     (1 slot da 50 min — vive 1 mese)
    "annual":    300 min    (6 slot da 50 min — vivono fino a 6 mesi, non cumulabili tra loro)
}
```

### Cap hard mensile (consumo massimo in un singolo mese)

```
TIER_MONTHLY_HARD_CAP = {
    "monthly":   500 min   (500 base + 0 pool)
    "bimonthly": 550 min   (500 base + max 50 dal pool)
    "annual":    550 min   (500 base + max 50 dal pool, slot NON cumulabili nello stesso mese)
}
```

### Soglia warning
```
WARNING_THRESHOLD_PCT = 0.90   (90% del budget → avviso in-personaggio)
```

### Costo di riferimento per overage
```
OVERAGE_COST_PER_MINUTE_EUR = 0.03 €/min
```
(Allineato al costo reale ElevenLabs misurato in dashboard: €0,021–0,024/min + margine sicurezza. Prima era €0,091, stima pre-lancio contraddetta dai dati reali.)

---

## 6. TRIAL GRATUITO

Fonte: `server.py` righe 4620–4628.

| Parametro | Valore |
|---|---|
| Budget totale | **420 secondi = 7 minuti di TTS Ollenya live** |
| Durata finestra | **5 giorni** dall'`onboarded=true` |
| Zona closing (grazia) | **da 300 s (5 min) a 420 s (7 min)** — Ollenya emette congedo relazionale |
| Prezzo | 0 € |
| Expired | Scatta se **UNA SOLA** delle due condizioni è vera (budget esaurito OR finestra scaduta) |

Turni 0-8 pre-registrati (asset locali, non passano dal server) → **non contati**.
Turno 6 (pronuncia nome utente) → **contato dal primo secondo**.
Turno 9 in poi (free-talk) → **contato normalmente**.

---

## 7. LIMITI CHAT SCRITTA (non TTS)

Fonte: `server.py` righe 4586–4589 + `.env` righe `OLLENYA_FREE_*`, `OLLENYA_PREMIUM_*`.

| Tier | Limite giornaliero | Limite mensile |
|---|---|---|
| Free (post 24h) | 5 turni/giorno | — |
| Free (prime 24h) | 20 turni/giorno (boost) | — |
| Free (nuovo gate v65.53) | 5 turni ogni 72 ore | — |
| Premium | 150 turni/giorno (legacy) o **200 turni/giorno** (hardcap anti-abuso v65.54) | 250 turni/mese (legacy) |
| Premium alert admin | 80% × 3 giorni consecutivi → email automatica | — |

---

## 8. CALCOLO ECONOMICO AVALLATO

Fonte: commento `server.py` righe 4595–4611.

### Costo overage worst-case (mix reale V3 + Flash misurato in dashboard)
```
€ 0,044 / minuto
```

### Uso medio realistico stimato
```
150 – 180 minuti / mese per utente attivo
```

### Margini worst-case (utente al cap hard mensile in overage puro)

| Piano | Prezzo | Cap hard | Costo | Margine | % |
|---|---|---|---|---|---|
| **Mensile** | € 19,99 | 500 min (nota: valori storici 100 min nel commento) | € 4,40 | **+ € 15,59** | **78 %** |
| **Bimestrale** | € 35,99 | 550 min (storicamente 300) | € 13,20 | **+ € 4,80** | **27 %** |
| **Annuale** | € 209,99 | 550 min (storicamente 380) | € 16,72 | **+ € 0,78** | **5 %** |

> **AVVISO**: Il calcolo margini qui riprodotto è quello storico presente nel commento del codice. I numeri base erano **100/200/350 min** (vecchio design pre-2026-08). La configurazione ATTUALE in `TIER_MONTHLY_BUDGET` è **500 min per tutti i tier**. I margini vanno **ricalcolati** con i nuovi cap:
> - Mensile: 500 min × €0,03 = €15 costo → margine €4,99 (**25 %**)
> - Bimestrale: 550 min × €0,03 = €16,50 costo → margine €19,49 (**54 %** su 2 mesi, o 27 % equivalente mensile)
> - Annuale: 550 min × €0,03 × 12 = €198 costo → margine €11,99 (**6 %**)
>
> La tabella storica resta valida solo se il cap resta 100/200/350 min, condizione **NON PIÙ VERA** nella config attuale. Prima di comunicare questi margini all'esterno, scegliere quale cap applicare.

---

## 9. CHECKLIST VERIFICA — Comandi per rileggere i valori dal codice

```bash
# Budget V3 giornaliero
grep -n "KODA_TTS_V3_DAILY_BUDGET" /app/backend/server.py

# Regola V3 restrittiva
sed -n '254,272p' /app/backend/tts_intensity_classifier.py

# Soglie minuti mensili + carryover
sed -n '4636,4665p' /app/backend/server.py

# Trial free
sed -n '4620,4628p' /app/backend/server.py

# Mix misurato 16.7% / 83.3%
grep -n "16.7\|83.3\|716 turni" /app/backend/server.py /app/backend/tts_intensity_classifier.py
```

---

## 10. VALORI UNICI DA RICORDARE

| Metrica | Valore esatto | File / Riga |
|---|---|---|
| V3 share misurata (classifier v0) | **16,7 %** | `server.py:84`, `classifier:14` |
| Turbo share misurata (classifier v0) | **83,3 %** | `server.py:85`, `classifier:15` |
| V3 cost cut atteso v1 | **–55 / –60 %** | `classifier:227` |
| V3 share attesa v1 | **~6,7 – 7,5 %** | derivato |
| Budget V3 / giorno / utente | **10 turni** | `server.py:5013` |
| Trigger V3 restrittivo | `intensity==4` **OR** safety nums | `classifier:214–220` |
| Numeri safety che forzano V3 | **1522, 112, 118, 113, telefono azzurro** | `classifier:73` |
| Audio tag max per reply | **1** | `server.py:3242` |
| Budget base mensile Premium | **500 min** (tutti i tier) | `server.py:4636–4640` |
| Carryover mensile | **0 min** | `server.py:4647` |
| Carryover bimestrale | **1 slot × 50 min** | `server.py:4648` |
| Carryover annuale | **6 slot × 50 min**, non cumulabili | `server.py:4649` |
| Cap hard mensile | **500 / 550 / 550 min** | `server.py:4652–4656` |
| Warning utente | **90 %** del budget | `server.py:4658` |
| Costo overage riferimento | **€ 0,03 / min** | `server.py:4664` |
| Trial free | **7 min / 5 gg** | `server.py:4626–4628` |
| Hardcap Premium chat scritta | **200 turni / giorno** | `.env` |
| Hardcap alert admin | **80 % × 3 gg consecutivi** | `.env` |
