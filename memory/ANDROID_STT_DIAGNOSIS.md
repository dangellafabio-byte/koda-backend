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

## Evidenza — Log Honor (2026-07-24T16:29)

**Confermato: bug identico a Huawei, quindi baseline Android, NON EMUI-specifico.**

```
[KODA_STT_SOURCE] engine=deepgram (fallback, apple unsupported: platform_not_ios)
[KODA_STREAM_CLIENT] audio_route detected → builtin (device: LLY-LX1 = Honor)
[KODA_STT_BITRATE_CHECK] platform=android bitrate=64000 sampleRate=16000
  expected_android=64000 expected_ios=32000
[KODA_STREAM_CLIENT_CHUNK] idx=1 size=26840B record_dur=3644ms read=5ms send=25ms
[KODA_STREAM_CLIENT] stt_final text=[DIAG probe=? rms=-40.5 peak=-18.8
  route=builtin gain_max=1... conf=null dur=nullms
[KODA_STREAM_CLIENT] sentence_header i=0 text="Mi è sfuggito, come dicevi?"
  ← fallback AI reply (non ha capito la trascrizione)
```

**Comparazione side-by-side Huawei vs Honor:**

| Voce | Huawei (test 1) | Honor (test 2) |
|------|----------------|----------------|
| STT engine | deepgram (Android) | deepgram (Android) |
| Bitrate | 64000 | 64000 (identico) |
| Sample rate | 16000 | 16000 (identico) |
| Chunk size | 24504 B / 3181ms | 26840 B / 3644ms (simile) |
| WS send | 7ms | 25ms (network fluctuation, non rilevante) |
| RMS | -27.9 dB | -40.5 dB (mic Honor più silenzioso o gain diverso) |
| `[DIAG probe=...]` | `aac/16000/1ch/64000` ← formato riconosciuto | **`?`** ← formato NON riconosciuto dal backend |
| STT return | `[DIAG probe=aac/...]` | `[DIAG probe=?...]` |

**Nuova osservazione critica dall'Honor:** il backend probe torna `?` invece del formato — significa che ffprobe/mediainfo lato server NON riesce nemmeno a identificare il container del file AAC prodotto da Honor. **Peggio del caso Huawei**, dove almeno il formato veniva riconosciuto ma Deepgram non trascriveva.

Questo aggiunge una sfumatura all'ipotesi tecnica:
- Non è "solo" un problema di codec AAC compatibile con Deepgram
- Alcuni device Android potrebbero produrre AAC malformato / senza header validi che neanche parser generici (ffprobe) riconoscono
- Rende l'Opzione 2 ("fix formato AAC lato client") ancora più rischiosa: potresti fixarlo su un modello Android e rompersi su un altro

## Conclusione rafforzata (2026-07-24)

**Due device Android diversi (Huawei + Honor), stesso identico sintomo strutturale + variazione peggiorativa su Honor.** Definitivamente NON un problema hardware/OEM-specifico ma architetturale del path Deepgram+AAC su Android.

**Raccomandazione più forte per Opzione B**: porting `expo-speech-recognition` native (Google SpeechRecognizer on-device) è ormai l'unica strada realistica. L'Opzione 2 (fix formato AAC) è potenzialmente un pozzo senza fondo con OEM diversi che producono AAC diversamente. Opzione 1 (porting nativo) risolve alla radice.


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
   - **Effort stimato: 1-2 giorni tecnici ideali → 2-4 giorni realistici con
     2-3 giri di verifica/fix.** Nota di realismo (dall'utente, sessione
     2026-07-24): la storia del path iOS ha mostrato che ogni feature audio
     richiede più iterazioni del previsto (bug non ovvi emergono solo su
     device reali, disallineamenti build/deploy, edge case OS-specifici).
     Pianificare il porting con la finestra realistica, non quella ideale,
     per evitare frustrazione da "fatto → in realtà no → un altro giro".
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
