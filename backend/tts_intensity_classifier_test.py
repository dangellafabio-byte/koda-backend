"""Smoke test del classificatore TTS — policy v1 restrittiva (Fabio 2026-09-11).

Non è pytest — solo assert per validare che il modulo produzione
riproduca esattamente le decisioni della policy V3-rara.

Policy v1 (2026-09-11):
    V3 SOLO se: intensity == 4 (crisi acuta) OR safety_nums (1522/112/...)
    Turbo altrimenti (include ex-V3 di v0: TENERE, ADMIT_FAULT, tone_concerned,
    intensity 3, gioia forte, SALIRE senza tone concerned).

Esegui:  python /app/backend/tts_intensity_classifier_test.py
"""
import sys
sys.path.insert(0, "/app/backend")
from tts_intensity_classifier import (
    classify, V3_MODEL_ID, TURBO_MODEL_ID,
    MODE_SALIRE, MODE_TENERE, MODE_ADMIT, MODE_SPECCHIO,
)

TESTS = [
    # (description, text, tone, expected_model, expected_reason_substr, expected_mode)

    # === V3 residuo: SOLO crisi acuta (intensity==4) o safety numbers ===
    (
        "SALIRE + concerned → V3 (crisi acuta, intensity=4)",
        "Fabio, aspetta. Sei ancora lì? Mi dici cosa stai provando?",
        "concerned", V3_MODEL_ID, "intensity_max", MODE_SALIRE,
    ),
    (
        "Numero safety 1522 → V3 (safety obbligatoria)",
        "Se ti va, prova a chiamare il 1522. Sono lì per aiutare, davvero.",
        "warm", V3_MODEL_ID, "safety_nums", MODE_SALIRE,
    ),
    (
        "Numero safety 112 → V3",
        "Chiama subito il 112 e resta al telefono, non chiudere.",
        "urgent", V3_MODEL_ID, "safety_nums", None,
    ),

    # === Downgrade v0→v1: prima erano V3, ora Turbo (INTENZIONALE) ===
    (
        "ADMIT_FAULT → Turbo (humility ora è Turbo)",
        "Hai ragione, mi sono incartata male. È stata una mia cazzata. Scusa davvero.",
        "warm", TURBO_MODEL_ID, "default_turbo", MODE_ADMIT,
    ),
    (
        "TENERE su concerned → Turbo (validazione ferma non più V3)",
        "Hai ragione a essere arrabbiato con lei. È normale, non ti stai esagerando.",
        "concerned", TURBO_MODEL_ID, "default_turbo", MODE_TENERE,
    ),
    (
        "SALIRE su warm → Turbo (rallentamento senza tono concerned = Turbo)",
        "Aspetta. Sono qui. Prenditi il tempo che serve.",
        "warm", TURBO_MODEL_ID, "default_turbo", MODE_SALIRE,
    ),
    (
        "concerned SPECCHIO senza mode marker → Turbo (concerned generico non più V3)",
        "Fabio, mi sembra che tu stia elencando categorie, non parlando. Cosa succede?",
        "concerned", TURBO_MODEL_ID, "default_turbo", MODE_SPECCHIO,
    ),
    (
        "Gioia forte (has_joy + long) → Turbo (intensity=3 non più V3)",
        "Che bello! Sono davvero felice per te, dimmi tutto adesso.",
        "warm", TURBO_MODEL_ID, "default_turbo", MODE_SPECCHIO,
    ),

    # === Anti-regression: casi ovvi Turbo (invariati da v0) ===
    (
        "Saluto breve warm → Turbo",
        "Ciao Fabio, sto bene, e tu?",
        "warm", TURBO_MODEL_ID, "default_turbo", MODE_SPECCHIO,
    ),
    (
        "Meteo neutral → Turbo",
        "Domani a Milano sarà sereno, intorno ai 31 gradi. Vento moderato.",
        "neutral", TURBO_MODEL_ID, "default_turbo", MODE_SPECCHIO,
    ),
    (
        "Chiacchiera warm lunga → Turbo (zona grigia approvata da Fabio)",
        "Fabio, una riflessione lunga non è il mio stile — io sono più del "
        "momento, delle parole che servono adesso. Ma ti dico quello che vedo: "
        "la vita non è una cosa da risolvere, è una cosa da attraversare.",
        "warm", TURBO_MODEL_ID, "default_turbo", MODE_SPECCHIO,
    ),
    (
        "Consiglio warm leggero → Turbo",
        "Dipende da che umore hai. Se vuoi staccare la testa, tipo un Coen Brothers.",
        "warm", TURBO_MODEL_ID, "default_turbo", MODE_SPECCHIO,
    ),

    # === Safe fallback: senza segnale → V3 (invariato) ===
    (
        "Tone None → V3 safe",
        "Un testo qualsiasi ma senza tono estratto.",
        None, V3_MODEL_ID, "insufficient_signal", MODE_SPECCHIO,
    ),
    (
        "Testo cortissimo → V3 safe",
        "Ah.",
        "warm", V3_MODEL_ID, "insufficient_signal", MODE_SPECCHIO,
    ),
]


def run():
    passed = 0
    failed = 0
    for desc, text, tone, exp_model, exp_reason_sub, exp_mode in TESTS:
        d = classify(text, tone)
        ok_model = d.model_id == exp_model
        ok_mode = (exp_mode is None) or (d.mode == exp_mode)
        ok_reason = (exp_reason_sub is None) or (exp_reason_sub in d.reason)
        ok = ok_model and ok_mode and ok_reason
        status = "✓" if ok else "✗"
        print(f"  {status} {desc}")
        if not ok:
            print(f"      expected: model={exp_model} mode={exp_mode} reason~={exp_reason_sub}")
            print(f"      got:      model={d.model_id} mode={d.mode} reason={d.reason} "
                  f"intensity={d.intensity} words={d.n_words}")
            failed += 1
        else:
            passed += 1
    print(f"\n{passed}/{passed+failed} PASSED")
    return failed == 0


if __name__ == "__main__":
    ok = run()
    sys.exit(0 if ok else 1)
