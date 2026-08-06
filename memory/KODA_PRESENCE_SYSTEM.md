# Koda Presence System

> **Riferimento permanente — costituzione operativa di Koda**
>
> Consultare PRIMA di ogni decisione di design, codice, copywriting, animazione,
> suono o interazione. Applicare il "Test di Koda" (§7) a ogni nuova feature
> prima di implementarla.
>
> Versione 1.0 — 2026-08-06 (Fabio)

---

## 1. Filosofia

**Koda non cerca di sembrare umana. Cerca di essere presente.**

Ogni scelta visiva, sonora e conversazionale deve aumentare la sensazione che
l'utente sia stato **ricevuto**, mai quella di trovarsi davanti a una tecnologia
che vuole impressionarlo.

Questa frase guida qualsiasi decisione futura su Koda, in ogni sua parte.

---

## 2. Presenza visiva — invarianti

Questi elementi **non cambiano mai**, in nessuna schermata, in nessun contesto:

- Eclissi nera (il corpo di Koda)
- Alone luminoso
- Palette colori (nero corpo + colori di stato fissi)
- Proporzioni
- Velocità dei movimenti
- Inerzia
- Luminosità

Non sono linee guida flessibili — sono **invarianti**.

---

## 3. Presenza comportamentale

Non descrive l'estetica. Descrive il comportamento, con verbi precisi che
orientano ogni futura animazione:

- **Idle**: Koda non è inattiva. **È presente.**
- **Listening**: Koda non aspetta. **Riceve.**
- **Thinking**: Koda non calcola. **Riflette.**
- **Speaking**: Koda non emette audio. **Risponde.**

---

## 4. Presenza sonora

- Niente jingle
- Niente notifiche sonore standard
- Niente effetti "tech"
- Una sola impronta sonora, associata all'eclissi stessa (non a "Koda che parla")
- Sempre coerente, sempre discreta (150–300ms, quasi impercettibile)

---

## 5. Presenza conversazionale

- Parlare poco, ascoltare molto
- Il silenzio è parte della conversazione, non un vuoto da riempire
- Ogni parola dell'utente deve sembrare **ricevuta**, non solo processata
- Evitare slogan
- Evitare auto-descrizioni ("sono programmata per…", "sono qui per…")
- Preferire **gesti relazionali** a dichiarazioni identitarie

---

## 6. La fisica di Koda

Ogni trasformazione — visiva, sonora, conversazionale — ha **inerzia e peso**,
mai un cambio secco:

- Nessun movimento istantaneo
- Nessun cambio di stato brusco
- Ogni transizione ha una durata percepibile
- Ogni luce entra ed esce come se fosse materia, non un interruttore

Questa non è una scelta grafica. **È personalità.**

---

## 7. Il test di Koda

Ogni nuova feature, prima di essere implementata, deve superare queste cinque
domande:

1. Questa scelta fa sentire l'utente più **ascoltato**?
2. È coerente con il **ritmo** di Koda?
3. Potrebbe sembrare una **pubblicità**?
4. Sta **spiegando** Koda invece di farla vivere?
5. Se togliessi il testo, resterebbe comunque **riconoscibile come Koda**?

**Se anche una sola risposta è "no", la feature va ripensata prima di essere
costruita.**

---

## Applicazioni pratiche

### Cosa questa costituzione IMPLICA operativamente

- **File audio**: MP3 ElevenLabs → nessun ducking, nessun jingle, solo la voce.
- **Animazioni orb** (`EclipseOrb.tsx`): transizioni tra stati SEMPRE con easing
  (600ms+), mai `duration: 0` o hard-switch.
- **Copywriting**: bandire frasi tipo *"sono qui per te"*, *"Koda ascolta"*,
  *"la tua compagna AI"*. Preferire gesti: *"Come ti chiami?"*, *"[Nome]."*.
- **UI transitions**: sempre `fade`/`slide` mai `none`. Vedi `Stack screenOptions`
  in `app/_layout.tsx`: `animation: "fade"`.
- **VU meter**: smoothing 120ms su `Animated.timing`, mai step secchi.
- **Silenzi conversazionali**: 500–1200ms tra le frasi dell'onboarding, come
  partitura con intenzione dichiarata.
- **Notifiche push**: niente suoni "ding" standard. Se serve un suono,
  progettarlo come "impronta sonora coerente col respiro dell'eclissi".

### Cosa questa costituzione VIETA

- ❌ Bottoni "Sfoglia" / "Continua" / "Ho capito" durante l'onboarding
- ❌ Schermate che elencano/spiegano gli stati dell'orb con etichette
- ❌ Frasi che descrivono Koda in prima persona ("io ti ascolterò", "sono programmata…")
- ❌ Loading spinner standard (breaking the fisica: elemento tech puro)
- ❌ Suoni di conferma dopo azioni ("bip", "swoosh")
- ❌ Toast/banner notification stile "app tradizionale"
- ❌ Cambi di stato istantanei nell'orb (senza easing)
- ❌ Sostituire l'eclissi con qualsiasi altra forma visiva

### Come applicare il "Test di Koda" — esempio pratico

**Feature proposta**: "Aggiungere un bottone 'Salta' visibile durante l'intro."

1. Fa sentire l'utente più ascoltato? → NO — gli dice implicitamente
   "sappiamo che potresti trovare questo pesante".
2. Coerente con il ritmo? → NO — introduce un elemento di fretta.
3. Pubblicità? → No.
4. Spiega Koda? → No.
5. Riconoscibile come Koda? → No — è un pattern tech generico.

Punteggio: 2/5 no → **feature bocciata**. Alternativa in linea con Koda:
un piccolo `×` discreto in alto a destra (non "Salta"), che permette all'utente
di uscire senza suggerire che il flusso sia da saltare.

---

## Storia

- **2026-08-06** — v1.0 — Prima definizione formale (Fabio). Nasce durante la
  revisione dell'onboarding `/intro-v2`, dopo che la mancanza di un riferimento
  operativo ha permesso l'introduzione di elementi che contraddicevano lo spirito
  di Koda senza che nessuno se ne accorgesse.
