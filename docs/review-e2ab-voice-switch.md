# Review of e2ab00bbac7f20f7ea451bf6d8573653558513db

No push, deployment, OTA, build or paid API calls were made in this review.

## Blockers reproduced on the app's actual source

1. `voiceClientStt.ts:1031-1048`: cleanup after `doneReceived` still calls the global native recognizer's `stop()`. This can affect a subsequent turn. An actual-class regression fails with one stop instead of zero.
2. `voiceClientStt.ts:922`: the native stop in final dispatch was removed entirely. With Android `continuous: true`, a final result does not justify assuming the recognizer has ended. The actual-class regression dispatches its transcript but observes zero native stop calls. Restore finalization while making completed-turn cleanup inert.
3. `ttsProviderClient.ts:208`: HTTP 404 is accepted as successful reset. A missing route does not prove that the preference was deleted. A runtime regression confirms that this clears the local setting incorrectly.
4. `api_tts` and `api_tts_prepare` still initialize/check ElevenLabs before dispatching Inworld. Actual-function tests confirm the wrong-provider initialization in both endpoints.
5. The short-transcript branch still converts an Inworld error into an empty-audio sentence plus successful done. An actual-function regression confirms that no explicit provider error is emitted.

Additional issues retained in the reviewed branch: preference lookup/deletion errors can be swallowed, fallback to ElevenLabs remains possible on resolution errors, static Vento assets explicitly point to ElevenLabs under Inworld, and the 300ms hydration race does not guarantee the selected provider has been loaded.

## Tests in the supplied branch

The 16 static assertions pass, but do not establish runtime correctness. `memory/scripts/test_stt_stop_lifecycle.js:72` defines a copied `FakeSession` rather than loading `VoiceClientSttSession` from the app. Its five passing scenarios therefore do not exercise production listeners, cleanup or dispatch.

## Supplementary repair

Based strictly on e2ab00bb. Keeps the useful asset getter and backend end/error changes. Repairs the issues above, keeps Inworld's approved model/voice/rate unchanged, and does not change LLM configuration, prompts, memory, minute accounting, intro text or paywall rules. Under Inworld, unsupported Vento static assets now raise an explicit error rather than play ElevenLabs.

The updated tests load the actual TS class with native mocks and execute the actual Python functions extracted by AST with mock DB/providers. They do not import/start the production server. Node >=22.13 with TS stripping or the project's existing TypeScript dev dependency is required.

Validation: 15 frontend behavioral tests + 7 backend behavioral tests pass locally. Python parsing/compilation and diff whitespace checks pass. No real microphone, device player, production database or LLM call was exercised. Mocked Android lifecycle checks do not certify physical-device behavior.

Commands:

```
python memory/scripts/test_fix_switch_bugs.py
node memory/scripts/test_stt_stop_lifecycle.js
node memory/scripts/test_warmup_url_rewrite.js
```

## Unresolved live 403

No evidence collected here establishes the origin of the Emergent HTTP 403. It is not fixed by this patch and remains a separate deployment verification prerequisite. Neither an empty transcript nor an HTML 403 proves a permissions or WAF diagnosis.

Do not merge to main: the existing push workflow publishes OTA to multiple channels. Review on the isolated branch first. No automatic deployment is authorized by these notes.
