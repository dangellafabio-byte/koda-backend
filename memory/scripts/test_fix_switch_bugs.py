#!/usr/bin/env python3
"""
Test di validazione statica delle correzioni introdotte in questa patch.

NON esegue chiamate API a pagamento. NON apre WebSocket reali. NON apre il
server FastAPI. Legge i file sorgenti e verifica che:

1) Il ramo "non ti ho sentito" (`_fast_pipeline_task`) non chiami
   `ElevenLabs` prima di aver risolto il provider.
2) Il guard `_get_eleven_client() is None` non blocca più il percorso
   Inworld.
3) `/api/voice/stream` `end` senza transcript ritorna un `error`, non `done`.
4) `voiceClientStt.ts::stop()` aspetta il risultato finale (polling flag
   `recognizerEndedNatively` o `currentTranscript`).
5) `voiceClientStt.ts` ha un check `stopRequested` PRIMA di sendJson start.
6) Il warmup HTTP in `voiceClientStt.ts` strippa il query token (fix 404).
7) MicroDemo/HeartVoiceReveal/IntroPremium/IntroPremiumFinalStep risolvono
   gli asset AL momento della riproduzione (getter functions).
8) `lasciaAndareVoice.ts` risolve asset al play.
9) `_layout.tsx` attende hydrate TTS prima di setReady.
10) `ttsProviderClient.ts::resetProviderOnServer` solleva se backend fallisce.
"""
from __future__ import annotations
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / "backend"
FRONTEND = ROOT / "frontend"

errors: list[str] = []
passed: list[str] = []


def check(name: str, cond: bool, hint: str = "") -> None:
    if cond:
        passed.append(name)
        print(f"  ✅ {name}")
    else:
        errors.append(f"{name}: {hint}")
        print(f"  ❌ {name}  → {hint}")


# -----------------------------------------------------------------
# 1-2) Backend: ramo didnt_hear + guard EL non blocca Inworld
# -----------------------------------------------------------------
print("\n[1-2] Backend: _fast_pipeline_task — ramo didnt_hear + EL guard")
server_src = (BACKEND / "server.py").read_text()

# Il nuovo codice risolve provider PRIMA di chiamare ElevenLabs
dh_idx = server_src.find("_phrase = random.choice([")
assert dh_idx > 0, "ramo didnt_hear non trovato"
dh_block_end = server_src.find(
    "# Emit sentence: se abbiamo audio, il client lo suona", dh_idx
)
dh_block = server_src[dh_idx:dh_block_end]

# Il provider deve essere risolto PRIMA di _get_eleven_client
provider_pos = dh_block.find("_tts_provider_for_current_user()")
elevenlabs_pos = dh_block.find("_get_eleven_client()")
check(
    "didnt_hear: provider risolto prima di EL client",
    provider_pos > 0 and (elevenlabs_pos == -1 or provider_pos < elevenlabs_pos),
    f"provider_pos={provider_pos} el_pos={elevenlabs_pos}",
)

# Il ramo Inworld NON deve essere preceduto da convert() EL dentro didnt_hear
inworld_dispatch_pos = dh_block.find("_inworld_dispatcher.generate_non_streaming")
if_inworld_pos = dh_block.find('if _provider_dh == "inworld"')
check(
    "didnt_hear: Inworld in branch separato (non dopo convert EL)",
    if_inworld_pos > 0 and (
        dh_block.rfind("text_to_speech.convert(", 0, if_inworld_pos) == -1
    ),
    "convert ElevenLabs ancora chiamato prima di scelta Inworld",
)

# Guard EL non blocca Inworld
guard_idx = server_src.find('await _publish({"type": "error", "message": "TTS unavailable"})')
assert guard_idx > 0, "guard TTS unavailable non trovato"
pre_guard = server_src[max(0, guard_idx - 600):guard_idx]
check(
    "pipeline fast: provider resolve PRIMA del guard EL",
    "_tts_provider_for_current_user" in pre_guard
    and "_provider_for_turn ==" in pre_guard,
    "Guard EL blocca ancora Inworld",
)

# -----------------------------------------------------------------
# 3) voice_stream.py — end senza transcript = error
# -----------------------------------------------------------------
print("\n[3] voice_stream.py — end senza transcript → error")
vs_src = (BACKEND / "voice_stream.py").read_text()
end_block_idx = vs_src.find('client_stt got \'end\' without transcript')
assert end_block_idx > 0, "log line non trovata"
end_ctx = vs_src[end_block_idx:end_block_idx + 600]
check(
    "end-without-transcript: emette type=error",
    '"type": "error"' in end_ctx
    and "client_stt_end_without_transcript" in end_ctx,
    "il ramo end emette ancora done invece di error",
)

# -----------------------------------------------------------------
# 4-6) voiceClientStt.ts — stop/aspetta final, stopRequested, warmup
# -----------------------------------------------------------------
print("\n[4-6] voiceClientStt.ts — stop/pre-start check/warmup")
vcs_src = (FRONTEND / "lib/voiceClientStt.ts").read_text()

check(
    "stop() aspetta result finale (polling currentTranscript)",
    "finalWaitMs" in vcs_src and "recognizerEndedNatively" in vcs_src,
    "flag/polling mancanti in stop()",
)
check(
    "listener end setta recognizerEndedNatively=true",
    "this.recognizerEndedNatively = true;" in vcs_src,
    "flag non settato nel listener end",
)
check(
    "pre-start check stopRequested (prima di sendJson start)",
    "stopRequested=true BEFORE sendJson(start)" in vcs_src,
    "check pre-start assente",
)
check(
    "warmup URL strip query/token",
    "u.search = \"\"" in vcs_src and 'u.pathname = u.pathname.replace' in vcs_src,
    "warmup non pulisce la query → 404 persistente",
)

# -----------------------------------------------------------------
# 7-8) Asset getters al momento del play
# -----------------------------------------------------------------
print("\n[7-8] Asset Intro — risoluzione al play, non all'import")
md_src = (FRONTEND / "components/MicroDemoOllenya.tsx").read_text()
check(
    "MicroDemoOllenya: usa getter functions",
    "const getClipOpen" in md_src and "getClipOpen()" in md_src,
    "ancora costanti top-level",
)
hv_src = (FRONTEND / "components/HeartVoiceReveal.tsx").read_text()
check(
    "HeartVoiceReveal: usa getter function",
    "const getRevealClip" in hv_src and "getRevealClip()" in hv_src,
    "ancora costante top-level",
)
ip_src = (FRONTEND / "components/IntroPremium.tsx").read_text()
check(
    "IntroPremium: usa getter function",
    "const getClipEccomi" in ip_src and "getClipEccomi()" in ip_src,
    "ancora costante top-level",
)
ipfs_src = (FRONTEND / "components/IntroPremiumFinalStep.tsx").read_text()
check(
    "IntroPremiumFinalStep: usa getter function",
    "const getClipClosing" in ipfs_src and "getClipClosing()" in ipfs_src,
    "ancora costante top-level",
)
iv3_src = (FRONTEND / "components/OllenyaIntroV3.tsx").read_text()
check(
    "OllenyaIntroV3: map come thunks",
    "intro_v3_parte_di_me: () => getIntroAsset" in iv3_src
    and "typeof clipThunk === \"function\" ? clipThunk()" in iv3_src,
    "map ancora con valori statici",
)
la_src = (FRONTEND / "lib/lasciaAndareVoice.ts").read_text()
check(
    "lasciaAndareVoice: usa getter functions",
    "const getOpenCielo" in la_src and "getFirstBootCuoreClip()" in la_src,
    "ancora costanti top-level",
)

# -----------------------------------------------------------------
# 9) _layout.tsx — hydrate PRIMA di setReady
# -----------------------------------------------------------------
print("\n[9] _layout.tsx — hydrate TTS prima di render")
layout_src = (FRONTEND / "app/_layout.tsx").read_text()
check(
    "_layout.tsx: await hydrateTTS",
    "await hydrateTTS;" in layout_src,
    "hydrate ancora fire-and-forget",
)

# -----------------------------------------------------------------
# 10) resetProviderOnServer solleva se backend fallisce
# -----------------------------------------------------------------
print("\n[10] ttsProviderClient — reset propaga errore backend")
ttsc_src = (FRONTEND / "lib/ttsProviderClient.ts").read_text()
reset_block_idx = ttsc_src.find("export async function resetProviderOnServer(")
reset_body = ttsc_src[reset_block_idx:reset_block_idx + 1500]
check(
    "resetProviderOnServer: throw su backend KO",
    "throw lastErr" in reset_body
    and "backendDeleted" in reset_body
    and "await clearTTSProvider();" in reset_body,
    "reset ancora dichiara successo su backend 500",
)

# -----------------------------------------------------------------
print("\n" + "=" * 60)
print(f"RESULT: {len(passed)} passed, {len(errors)} failed")
if errors:
    print("\nFAILURES:")
    for e in errors:
        print(f"  - {e}")
    sys.exit(1)
sys.exit(0)
