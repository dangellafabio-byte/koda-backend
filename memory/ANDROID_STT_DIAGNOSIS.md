# Android STT — Diagnosi baseline (2026-07-24)

**Status:** Deferrato in Opzione C (lancio iOS-only). Da affrontare in Opzione B.

---

## Sintesi

Su **Android baseline** (Huawei tablet + Honor, entrambi falliscono) il path
Deepgram legacy (`voiceStream.ts` → WSS `/api/voice/stream`) **non funziona**:
Deepgram riceve l'AAC prodotto da Android ma ritorna trascrizione vuota. Il
backend risponde con la modalità DIAG probe echo.

Su **iOS** non emerge perché usiamo il path Fase B (`voiceClientStt.ts` con
Apple SFSpeechRecognizer on-device), che bypassa Deepgram completamente.

---

## Evidenza — Log Honor (2026-07-24)

```
[KODA_STT_SOURCE] engine=deepgram (fallback, apple unsupported: platform_not_ios)
[KODA_STREAM_CLIENT] audio_route detected → builtin
[KODA_STT_BITRATE_CHECK] platform=android bitrate=64000 sampleRate=16000
  expected_android=64000 expected_ios=32000
[KODA_STREAM_CLIENT] chunk #1 recording, wait 3000ms...
[KODA_STREAM_CLIENT_CHUNK] idx=1 size=24504B record_dur=3181ms read=2ms send=7ms
[KODA_STREAM_CLIENT] stt_final text=[DIAG probe=aac/16000/1ch/64000
  rms=-27.9 peak=-15.1 route=b... conf=null dur=nullms
```

**Cosa funziona:**
- Mic permission granted
- Audio route detection (builtin microphone)
- WS opens in 653ms
- AAC chunk recorded 24504B in 3181ms
- WS send OK (7ms)
- RMS -27.9 dB, peak -15.1 dB (livelli audio validi)
- Bitrate 64000, sampleRate 16000, 1ch (parametri corretti come da config)

**Cosa NON funziona:**
- Deepgram STT ritorna trascrizione vuota (`conf=null`)
- Backend fallback → risposta è la DIAG probe echo, non una trascrizione reale

**Riprodotto anche con audio più forte** (RMS -16.2, peak -3.6 in test
precedente Huawei) → stesso identico output DIAG probe. Esclude "audio
troppo debole" come causa.

---

## Ipotesi tecniche (per Opzione B)

L'AAC prodotto da `expo-audio` su Android potrebbe:

1. **Mancare degli ADTS headers** (Advanced Audio Coding con framing streamable).
   Deepgram AAC decoder si aspetta ADTS o container MP4/M4A. Il record
   Android `expo-audio` produce AAC raw?

2. **Usare un profilo AAC non supportato** (LC vs. HE-AAC vs. AAC-ELD). Deepgram
   supporta AAC-LC ma verificare che `expo-audio` non produca varianti.

3. **Container mismatch**: Android potrebbe fornire il chunk come raw AAC frames
   mentre iOS fornisce M4A/MP4 container. Deepgram gestisce entrambi ma vuole
   header espliciti.

---

## Opzioni di fix per Opzione B (in ordine di preferenza)

### 1. **Port native Android → `expo-speech-recognition`** (RACCOMANDATO)
   - Google SpeechRecognizer on-device, bypassa Deepgram completamente
   - Parity architetturale con iOS (Apple SFSpeechRecognizer)
   - Elimina il problema alla radice — nessun encoding/formato da debuggare
   - Beneficio secondario: latenza inferiore, funziona offline (parzialmente),
     nessun costo Deepgram su Android
   - Effort stimato: 1-2 giorni
   - File da toccare: `speech.ts` (feature flag path selection), nuovo
     `voiceClientSttAndroid.ts` sul modello di `voiceClientStt.ts`

### 2. **Fix formato AAC lato client Android** (patch)
   - Cambiare `expo-audio` config Android a PCM/WAV (Deepgram gestisce PCM
     perfettamente)
   - Oppure: aggiungere wrapping ADTS/M4A manuale prima del send
   - Rischio: potrebbero emergere altri bug audio Android (routing, codec)
   - Effort stimato: 4-8 ore, incerto se sufficiente

### 3. **Test isolato AAC Android vs Deepgram API**
   - Prima di scegliere 1 o 2, script Python che manda direttamente il chunk
     Android salvato (bytes esatti) a Deepgram HTTP API per confermare la causa
   - Serve un file `.aac` catturato da Honor (usare "Segnala un problema"
     future feature: dump binario del chunk)

---

## Note operative per il prossimo agent

- **Backend v60.5** (`b88ff7a7`) contiene già la modalità DIAG probe: la
  risposta `[DIAG probe=aac/16000/1ch/64000 ...]` è normale/attesa quando
  Deepgram ritorna vuoto. Non toccare.
- **iOS è isolato** dal problema: Opzione B non deve rompere il path iOS.
- **Feature flag** `EXPO_PUBLIC_USE_CLIENT_STT=true` già presente in
  `speech.ts:2023` — estendibile a `EXPO_PUBLIC_USE_CLIENT_STT_ANDROID=true`
  per il porting Android.
- **`voiceClientStt.ts`** è il template architetturale da replicare per
  Android (35kb, sessioni WS + STT on-device + close_session propagation).
