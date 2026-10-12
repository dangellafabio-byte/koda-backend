# Ollenya — Lista Completa Costi (consolidamento)

**Data**: 2026-10-09
**Fonte**: PRD + sessione agente + documento legale v69
**Scopo**: dare a Fabio il quadro ESATTO di cosa spende Ollenya al mese e all'anno, con la distinzione netta tra dati verificati e stime.

> Legenda: ✅ = numero misurato o da fonte ufficiale verificata · ⚠️ = stima (va validata) · 🔴 = sconosciuto, da chiedere a terzi

---

## 1. COSTI VARIABILI (dipendono dagli abbonati attivi)

### 1.1 ElevenLabs TTS

| Dato | Valore | Fonte |
|---|---|---|
| Modelli usati | 83% Turbo v2.5 + 17% V3 Alpha | ✅ PRD riga 1054 |
| Costo medio reale misurato | **€0,021-0,024/min TTS output** | ✅ PRD riga 932 (dashboard Fabio) |
| Costo medio dopo caching Anthropic | **€0,013/min effettivo totale (incluso Claude cached)** | ✅ PRD riga 998 |
| Piano Pro | $99/mese = **600.000 crediti**, Turbo = 1 cred/char (no sconto) | 🔴 **da verificare sul tuo account** |
| Piano Scale | $299/mese = **1.800.000 crediti**, Turbo = 0,5 cred/char | 🔴 da verificare |
| Piano Business | $990/mese = **6.000.000 crediti**, Turbo = 0,5 cred/char | 🔴 da verificare |
| Enterprise | custom, tipicamente 0,3-0,4 €/1k crediti | 🔴 negoziabile |

**Costo per abbonato annuale (500 min TTS/mese venduti)**:
- Al 30% utilizzo: ~**€3,00/mese** (su Scale/Business con Turbo scontato)
- Al 50% utilizzo: ~**€4,80/mese**
- Al 100% utilizzo: ~**€9,60/mese**

### 1.2 Deepgram STT (Speech-to-Text)

| Dato | Valore | Fonte |
|---|---|---|
| Modello usato | Nova-3 | ✅ codice backend |
| Prezzo | $0,0043/min = **€0,0040/min** | 🔴 listino pubblico Deepgram 2024 |
| Costo per abbonato annuale (uso 50%) | ~**€0,60/mese** | ⚠️ stima |

### 1.3 Anthropic Claude Haiku 4.5

| Dato | Valore | Fonte |
|---|---|---|
| Modello | claude-haiku-4-5 via Emergent LLM key | ✅ codice |
| Cost structure | input $0,80/1M + output $4,00/1M token | 🔴 Anthropic pubblico |
| Risparmio caching | **90,3% su input dopo cache HIT** | ✅ PRD riga 998 |
| Costo per abbonato annuale (uso 50%, con caching) | ~**€0,20-0,40/mese** | ⚠️ stima |

### 1.4 Tavily (Web Search, OPZIONALE)

| Dato | Valore |
|---|---|
| Prezzo | $0,004/query (Starter) · $0,008 (Pro) | 🔴 listino 2024 |
| Costo per abbonato (se web search attivo) | **~€0,05-0,15/mese** | ⚠️ stima bassa frequenza |

### 1.5 MongoDB Atlas

| Dato | Valore |
|---|---|
| Piano attuale | 🔴 **da verificare** (tier M0 free, M10 $57/mese, M20 $133/mese) |
| Costo per abbonato (shared) | ~**€0,05-0,15/mese** fino a ~500 utenti | ⚠️ stima |

### 1.6 Resend (email transazionali)

| Dato | Valore |
|---|---|
| Piano Emergent managed | **gratuito** fino a 3.000 email/mese | ✅ Emergent incluso |
| Oltre: Resend Pro | $20/mese = 50.000 email | 🔴 non ancora necessario |

### 1.7 Hosting backend / infrastruttura (Emergent)

| Dato | Valore |
|---|---|
| Costo attuale | **incluso nel piano Emergent attuale** | 🔴 **da verificare quanto paghi al mese** |
| Scala tipica fino a ~1.000 utenti | ~€30-100/mese variabile | ⚠️ stima |

---

## 2. COSTI FISSI AZIENDALI (indipendenti dagli abbonati)

### 2.1 Account sviluppatore

| Voce | Costo annuo |
|---|---|
| Apple Developer Program | **$99/anno = €92/anno** | ✅ listino pubblico |
| Google Play Console | **$25 una tantum** | ✅ listino pubblico |
| RevenueCat | **gratuito** fino a $10.000/mese MRR, poi 1,2% | ✅ listino |

### 2.2 Burocrazia Italia

| Voce | Costo annuo | Note |
|---|---|---|
| Commercialista | **€800-2.000/anno** | ⚠️ dipende dal professionista |
| Camera di Commercio (CCIAA) | **€88/anno** | ✅ listino 2025 |
| PEC | **€20-50/anno** | ✅ Aruba/Register.it |
| Firma digitale | **€30-80/anno** | ✅ listino |
| Software fatturazione elettronica | **€4-10/mese** (Aruba, Fatture in Cloud) | ✅ listino |
| Codice destinatario SDI | **gratuito** (via gestionale) | ✅ |

### 2.3 Legale (una tantum ammortizzato)

| Voce | Costo |
|---|---|
| Avvocato ToS + Privacy Policy + Disclaimer | **€1.000-2.500 una tantum** | ⚠️ preventivo medio |
| Ammortizzato su 3 anni | ~**€500/anno** | ⚠️ |

### 2.4 Dominio e identità

| Voce | Costo annuo |
|---|---|
| Dominio `ollenya.app` o simile | **€15-30/anno** | ✅ |
| Email aziendale (Google Workspace, €6/user/mese) | **€72/anno** | ✅ |

### 2.5 Totale costi fissi annuali (stima realistica)

```
Apple Dev:               €   92
Google Play (amm.):      €    5
Commercialista:          € 1.200
CCIAA:                   €   88
PEC + firma + SDI:       €  120
Fatturazione cloud:      €   72
Avvocato (amm. 3 anni):  €  500
Dominio + email:         €  100
Buffer software/vari:    €  200
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TOTALE ANNO 1 (bootstrap):  €2.377
TOTALE ANNO 2+:             €1.877
```

---

## 3. CONTRIBUTI PREVIDENZIALI (INPS)

### 3.1 Gestione Commercianti (ipotesi se iscrizione a Camera Commercio)

| Scenario | Importo annuo | Note |
|---|---|---|
| Pieno (worst case 2025) | **€4.296/anno** | ✅ listino INPS 2025 |
| Riduzione 50% con lavoro dipendente | **€2.148/anno** | ⚠️ discrezionale INPS |
| Esonero totale (raro, istanza motivata) | **€0** | ⚠️ da provare |

### 3.2 Gestione Separata (ipotesi alternativa professionista)

| Dato | Valore |
|---|---|
| Aliquota (iscritti ad altra forma obbligatoria) | **24% su reddito effettivo** | ✅ INPS 2025 |
| Reddito 0 → paga 0 | **€0 minimo garantito** | ✅ |

🔴 **Qui serve ASSOLUTAMENTE il parere del commercialista**: Commercianti vs Separata è il dubbio aperto.

---

## 4. IMPOSTE DIRETTE

### 4.1 Regime Forfettario (se applicabile)

| Dato | Valore |
|---|---|
| Soglia massima incassato | **€85.000/anno** | ✅ L. 190/2014 |
| Coefficiente di redditività ATECO 62.01.00 | **67%** | ✅ |
| Imposta sostitutiva | **5% primi 5 anni**, poi **15%** | ✅ |
| INPS pagato è deducibile | **sì, 100% dall'imponibile forfettario** | ✅ |

### 4.2 Regime Ordinario (obbligatorio sopra €85k)

| Dato | Valore |
|---|---|
| IRPEF scaglioni 2025 | 23% fino €28k · 35% fino €50k · 43% oltre | ✅ |
| Addizionale regionale | 1,23-3,33% (dipende regione) | ✅ |
| Addizionale comunale | 0-0,9% (dipende comune) | ✅ |
| **Deducibilità costi reali** | **100% documentati** | ✅ |

---

## 5. COSTI COMMERCIALI — Apple/Google

### 5.1 Catena commissioni per transazione

| Passaggio | % | Esempio su €209,99 (annuale) |
|---|---|---|
| Prezzo pubblico lordo | 100% | €209,99 |
| IVA 22% rimossa (versata al Fisco via MOSS) | -18% | − €37,87 → netto €172,12 |
| Commissione Apple/Google **Small Business 15%** | -12,75% | − €25,82 → **netto Ollenya €146,30** |
| OPPURE commissione standard **30%** | -25,5% | − €51,64 → netto Ollenya €120,48 |

### 5.2 Trial e refund

| Voce | % stimata | Note |
|---|---|---|
| Trial gratuito 7 giorni (opzionale) | -2% revenue | ⚠️ se attivato |
| Refund entro 14 giorni (store policy) | -3-5% subscribers | ⚠️ industry benchmark |

---

## 6. RICAVO NETTO PER ABBONATO ANNUALE

```
Prezzo pubblico:              €209,99
− IVA 22%:                   - €37,87
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Netto IVA (base commissione): €172,12
− Commissione store 15%:     - €25,82
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
INCASSO NETTO OLLENYA/anno:   €146,30
= €12,19/mese per abbonato annuale
```

Con commissione 30% (worst case): €120,48/anno = €10,04/mese.

---

## 7. COSTO VARIABILE TOTALE PER ABBONATO (annuale, 50% utilizzo medio)

```
ElevenLabs TTS (su Scale):    €4,80/mese
Deepgram STT:                 €0,60/mese
Claude Haiku (cached):        €0,30/mese
Tavily (se attivo):           €0,10/mese
MongoDB shared:               €0,10/mese
Hosting shared (Emergent):    €0,15/mese
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TOTALE variabile/mese/user:   €6,05
TOTALE variabile/anno/user:   €72,60
```

---

## 8. MARGINE DI CONTRIBUZIONE (euro per abbonato annuale)

```
Incasso netto Ollenya/anno:   €146,30
− Costi variabili/anno:       - €72,60
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
MARGINE CONTRIBUZIONE/user:   €73,70/anno
                              = €6,14/mese per abbonato
```

**Scenari sensibilità**:
- Al 30% uso (bassa attività utente): margine ~€95/anno
- Al 70% uso (alta attività): margine ~€40/anno
- Al 100% uso (worst): margine ~€15/anno
- Commissione 30% invece di 15%: margine ~€48/anno al 50% uso

---

## 9. BREAK-EVEN

### 9.1 Break-even operativo (solo copertura tecnica/fissa, no INPS/tasse)

```
Costi fissi anno 2+:         €1.877
Costi variabili (per user):  €72,60
Margine contribuzione:       €73,70/user

Break-even: 1.877 / 73,70 = ~26 abbonati annuali
```

### 9.2 Break-even aziendale (fissi + INPS realistic 50%)

```
Costi fissi anno 2+ + INPS:  €1.877 + €2.148 = €4.025
Break-even: ~55 abbonati annuali
```

### 9.3 Break-even reale (fissi + INPS pieno + Tasse)

```
Costi fissi:                €1.877
INPS worst case:            €4.296
Tasse forfettario 5%:       calcolata sul margine imponibile
Imposta su €55 × 67% × 5%:  ~€100/user
Break-even: ~90-120 abbonati annuali
```

---

## 10. SIMULAZIONI (annuali, 50% utilizzo, Scenario BASE)

| Abbonati | Incasso netto | Variabili | Fissi | INPS 50% | Imposta 5% | **Utile** |
|---|---|---|---|---|---|---|
| 10 | €1.463 | €726 | €1.877 | €2.148 | €0 | **−€3.288** 🔴 |
| 25 | €3.658 | €1.815 | €1.877 | €2.148 | €0 | **−€2.182** 🔴 |
| 50 | €7.315 | €3.630 | €1.877 | €2.148 | €0 | **−€340** 🔴 |
| 75 | €10.973 | €5.445 | €1.877 | €2.148 | €126 | **€1.377** ✅ |
| 100 | €14.630 | €7.260 | €1.877 | €2.148 | €194 | **€3.151** ✅ |
| 200 | €29.260 | €14.520 | €1.877 | €2.148 | €359 | **€10.356** ✅ |
| 500 | €73.150 | €36.300 | €1.877 | €2.148 | €1.123 | **€31.702** ✅ |
| 580 (soglia forfettario) | €84.854 | €42.108 | €1.877 | €2.148 | €1.317 | **€37.404** ✅ |

---

## 11. COSE DA VERIFICARE (CRITICHE per avere il quadro definitivo)

### 🔴 Da chiedere al commercialista
1. Classificazione INPS corretta (Commercianti vs Separata)
2. Possibilità esonero/riduzione INPS con lavoro dipendente
3. Codice ATECO: 62.01.00 confermato o alternativa 58.29?
4. Trattamento IVA fatture Apple/Google (reverse charge + INTRA-12?)
5. Diritto di recesso Art. 59 Codice Consumo per IAP

### 🔴 Da verificare sul tuo account ElevenLabs
1. Piano attuale e crediti inclusi
2. Costo per 1.000 crediti in overage
3. Possibilità Enterprise con minimo garantito

### 🔴 Da verificare sul tuo account MongoDB Atlas
1. Tier attuale (M0 free, M10 $57, M20 $133, M30 $256)
2. Storage usato attualmente
3. Letture/scritture mensili

### 🔴 Da verificare sul pannello Emergent
1. Costo mensile piano attuale
2. Limiti CPU/RAM/traffico

---

## 12. RIEPILOGO ULTRA-SINTETICO

**Per fare profitto SOSTENIBILE** (non andare in rosso, pagare INPS e tasse):
- Minimo necessario: **~75 abbonati annuali stabili** nel primo anno
- Target comodo: **100-200 abbonati annuali** nel primo anno
- Soglia uscita forfettario: **~580 abbonati annuali**

**Costo totale di ogni abbonato annuale (tutto incluso)**:
- Media stimata: **€72-85/anno** di costi (46-58% dell'incasso netto)
- Margine utile per utente dopo tutto: **€30-50/anno** nel scenario base

**Rischi principali**:
- Se ElevenLabs sale al 100% utilizzo medio → margini si dimezzano
- Se finisci in commissione 30% invece di 15% → perdi altri €26/user/anno
- Se INPS Commercianti pieno (€4.296) → serve 20+ abbonati solo per quello

---

## Changelog documento

- **v1 (2026-10-09)**: prima stesura consolidata dai dati sparsi in PRD + conversazione agente + documento legale. Tutti i numeri marcati per fonte e grado di verifica.
