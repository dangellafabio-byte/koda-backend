# 🔒 KODA V2 — PRINCIPI ARCHITETTURALI IN CASSAFORTE

**Versione:** 1.0  
**Data congelamento:** 19 giugno 2026  
**Stato:** ⚠️ **NON IMPLEMENTARE ORA**  
**Autori del consenso:** Lorenzo (fondatore) + ChatGPT + Claude (analisi tecnica)  
**Approvato dall'agente sviluppatore:** Sì, in attesa.

---

## ⛔ PRIORITÀ ASSOLUTA — DA RICORDARE OGNI VOLTA

```
╔══════════════════════════════════════════════════════════════╗
║                                                              ║
║   PRIORITÀ ASSOLUTA: VAD → STT → LATENZA                    ║
║                                                              ║
║   Tutto il resto aspetta.                                    ║
║                                                              ║
║   Nessuna feature di personalità, scoring, insight o         ║
║   relationship engine viene implementata finché non sono     ║
║   verificati TUTTI i seguenti KPI sui device reali:          ║
║                                                              ║
║   ✅ Hands-free > 95% affidabile                             ║
║   ✅ Nessuna chiusura anticipata della registrazione         ║
║   ✅ Nessun "non ti ho sentito" falso                        ║
║   ✅ Latenza percepita < 3-4 secondi                         ║
║                                                              ║
║   Finché questi quattro punti non sono verdi, qualsiasi     ║
║   lavoro su Relationship Score, Insight Engine o Crisis     ║
║   Engine avanzato è PREMATURO e va RIFIUTATO.                ║
║                                                              ║
║   Il KPI che conta oggi è uno solo:                          ║
║   → L'utente apre Koda, parla, Koda ascolta fino alla        ║
║     fine, e risponde entro pochi secondi.                    ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
```

---

## 1. UTILIZZO DEL CAMPO `confidence` NEGLI INSIGHT

Tutti gli insight generati dal Motore Relazionale (quando esisterà) **devono** includere un valore di `confidence`.

### Esempio di insight strutturato

```json
{
  "energy": 35,
  "stress": 72,
  "listening_need": 88,
  "confidence": 0.82
}
```

### Regola di gating

| `confidence` | Comportamento |
|---|---|
| ≥ 0.60 | Insight valido → utilizzabile per tutto |
| 0.40 ≤ x < 0.60 | Insight ambiguo → log + telemetria, ma NO scrittura |
| < 0.40 | **Rumore** → scartato, mai usato per niente |

### Cosa fare con insight a bassa confidence

Quando `confidence < 0.40`:
- ❌ **NON** aggiornare le medie mobili dei parametri (energy, stress, ecc.)
- ❌ **NON** aggiornare il Relationship Score
- ❌ **NON** utilizzare l'insight per modificare il comportamento di Koda (toni, scelte di domande, proattività)
- ✅ Si **può** loggare per analisi statistica futura

### Razionale

Un modello LLM mini (gpt-5.4-mini, Claude Haiku) sbaglia spesso. Se ogni inferenza incerta scrive nel profilo utente, dopo 100 conversazioni il profilo è rumore. Meglio scartare 30% di dati che corrompere la memoria con 30% di errori.

---

## 2. ECCEZIONE DI SICUREZZA DELLA STANZA DELLO SFOGO

### Regola generale (V1, già attiva)

> "La Stanza dello Sfogo non alimenta la memoria personale di Koda."

I contenuti della Stanza Sfogo:
- ❌ Non scrivono su `taccuino_memories`
- ❌ Non aggiornano `taccuino_profile.memory_summary` o `core_traits`
- ❌ Non vengono recuperati in conversazioni future
- ❌ Non costruiscono profilo
- ✅ Confinati al buffer effimero `confessional_buffer` (TTL ~1h)

### Eccezione unica e tassativa

> Il **Crisis Detection Engine** resta sempre attivo, sia nella Stanza Quotidiana sia nella Stanza dello Sfogo.

**Motivazione:** la sicurezza dell'utente (rilevamento di intenti autolesivi, crisi acuta, richiesta d'aiuto) ha priorità assoluta rispetto alla separazione delle stanze.

### Limiti operativi dell'eccezione

Quando il Crisis Engine si attiva nella Stanza Sfogo:
- ✅ Può modificare la risposta in tempo reale (es. proporre contatti emergenza)
- ✅ Può escalare a UI di crisi
- ❌ **NON** può scrivere nella memoria relazionale (`taccuino_memories`)
- ❌ **NON** può scrivere nella timeline personale (`taccuino_timeline`)
- ❌ **NON** può aggiornare `core_traits`
- ✅ Può loggare anonimamente in collezione separata `safety_events` (senza contenuti, solo flag + timestamp + tipo crisi)

### Razionale

L'utente deve fidarsi che lo sfogo è davvero zero-knowledge. Se domani si scopre che la Sfogo "ha visto" qualcosa e l'ha usata per altro, il patto di fiducia è rotto irreparabilmente. La sicurezza è l'unica eccezione difendibile.

---

## 3. PRINCIPIO FONDATIVO DI KODA — IDENTITÀ vs STATI

### Regola madre

> **Koda non costruisce identità permanenti.**  
> Koda osserva stati temporanei, tendenze e cambiamenti.  
> Gli insight servono ad **adattare la relazione**, non a **definire la persona**.

### Cosa NON deve mai apparire all'utente

- ❌ "Il tuo livello di stress è 72/100"
- ❌ "Profilo personalità: ansioso, dipendente, introverso"
- ❌ "Tendenza al pensiero negativo: alta"
- ❌ Punteggi numerici di qualunque tipo che descrivono "chi sei"
- ❌ Classificazioni o etichette comportamentali presentate come verità
- ❌ Grafici/dashboard di "evoluzione della tua personalità"

### Cosa può fare Koda (e mostrare all'utente)

- ✅ "Mi sembra che oggi sia una giornata pesante. Vuoi parlarne?"
- ✅ "Ti ricordi quando, due settimane fa, mi avevi detto la stessa cosa? Allora ti aveva aiutato fare X."
- ✅ "Vedo che ci sentiamo spesso la sera. Va bene così, o ti farebbe piacere parlarne in altri momenti?"
- ✅ Riconoscere pattern temporali (frequenza, orari, intensità) come dato di servizio
- ✅ Adattare il TONO della risposta basandosi su stati momentanei stimati

### Distinzione chiave

| Stato (lecito) | Identità (vietata) |
|---|---|
| "Oggi sei più giù del solito" | "Sei una persona depressa" |
| "Negli ultimi giorni hai parlato molto di lavoro" | "Sei un workaholic" |
| "Stamattina la voce è più tesa" | "Sei una persona ansiosa" |

### Slogan interno

> **Koda non dice chi sei.**  
> **Koda cerca di capire come stai arrivando oggi.**

---

## 4. NOTA STRATEGICA DA FONDATORE

### Cosa non implementare adesso

Le tre regole sopra (confidence, eccezione safety, anti-identità) sono **principi architetturali per V2**. Si applicano a un Motore Relazionale e Crisis Engine **che ancora non esistono**.

Mettere mano a Relationship Score, Insight Engine o Crisis Engine avanzato **adesso** sarebbe un errore strategico, per tre ragioni:

1. **Costo opportunità:** ogni ora spesa su feature di personalità è un'ora non spesa sul vero collo di bottiglia (audio pipeline).
2. **Validazione prematura:** non sappiamo ancora se Koda funziona come prodotto base. Costruire intelligenza sopra un fondamento rotto significa raffinare il problema sbagliato.
3. **Rumore architetturale:** quando finalmente costruiremo l'Insight Engine, lo faremo con utenti reali e dati reali, non con assunzioni teoriche.

### Quando rimettere mano a questo documento

Riapri questo file **solo quando** TUTTI questi quattro KPI sono verdi su build production reale:

1. Hands-free > 95% affidabile (chiude da sola, non taglia, non aggancia)
2. Nessuna chiusura anticipata della registrazione
3. Nessun "non ti ho sentito" falso
4. Latenza percepita sotto i 3-4 secondi end-to-end

Fino ad allora, ogni volta che la conversazione devia verso insight/scoring/personalità, l'agente dev DEVE riportare la conversazione qui e citare il rettangolo in cima.

---

## 5. PROMEMORIA OPERATIVO PER L'AGENTE SVILUPPATORE

**Quando l'utente menziona uno dei seguenti termini:**

- "Motore Relazionale" / "Relationship Score"
- "Insight Engine" / "personalità di Koda"
- "Crisis Engine" / "Crisis Detection"
- "profilo psicologico" / "punteggi" / "tracking emotivo"
- "Koda capisce chi sono"
- "dashboard utente" / "evoluzione personale"

**L'agente DEVE:**

1. Riconoscere il riferimento a V2
2. Verificare lo stato dei 4 KPI bloccanti
3. Se anche uno solo è rosso → citare il rettangolo in cima e proporre di tornare al lavoro prioritario
4. Se tutti verdi → rileggere questo documento con l'utente prima di scrivere una riga di codice
5. Aggiornare questo documento solo dopo discussione esplicita con l'utente

**L'agente NON DEVE mai:**

- Proporre spontaneamente di implementare un Relationship Score
- Suggerire grafici/dashboard di evoluzione personale
- Implementare scrittura di "tratti psicologici" dedotti
- Bypassare l'eccezione safety (la Sfogo è zero-knowledge salvo Crisis Detection)
- Mostrare punteggi numerici di stato emotivo all'utente

---

## 6. RIFERIMENTI

- `/app/memory/V1_SPEC.md` — specifica prodotto V1 (congelata)
- `/app/memory/KODA_FULL_PACKAGE.md` — snapshot tecnico completo (aggiornato 18/6/2026)
- Conversazione del consenso: thread Lorenzo + ChatGPT + Claude del 18-19 giugno 2026 (sprint audio pipeline)

---

*Fine documento. Documento congelato fino a esplicita revisione concordata con il fondatore.  
Da rileggere ad alta voce ogni volta che la conversazione si avvicina a feature di "identità" prima del completamento del lavoro audio.*
