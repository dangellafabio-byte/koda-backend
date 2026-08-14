"""Smoke test del classificatore TTS.

Non è pytest — solo assert per validare che il modulo produzione
riproduca esattamente le decisioni dell'analisi offline sui casi
"anti-regression" identificati con Fabio.

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
    # === Anti-regression: casi ovvi V3 ===
    (
        "SALIRE + concerned → V3 (crisi)",
        "Fabio, aspetta. Sei ancora lì? Mi dici cosa stai provando?",
        "concerned", V3_MODEL_ID, "mode_high", MODE_SALIRE,
    ),
    (
        "ADMIT_FAULT → V3 (humility)",
        "Hai ragione, mi sono incartata male. È stata una mia cazzata. Scusa davvero.",
        "warm", V3_MODEL_ID, "mode_high", MODE_ADMIT,
    ),
    (
        "TENERE su concerned → V3 (validazione ferma)",
        "Hai ragione a essere arrabbiato con lei. È normale, non ti stai esagerando.",
        "concerned", V3_MODEL_ID, "mode_high", MODE_TENERE,
    ),
    (
        "SALIRE su warm → V3 (rallentamento intenzionale)",
        "Aspetta. Sono qui. Prenditi il tempo che serve.",
        "warm", V3_MODEL_ID, "mode_high", MODE_SALIRE,
    ),
    (
        "concerned SPECCHIO senza mode marker → V3",
        "Fabio, mi sembra che tu stia elencando categorie, non parlando. Cosa succede?",
        "concerned", V3_MODEL_ID, None, MODE_SPECCHIO,  # accept any reason
    ),
    (
        "Numero safety 1522 → V3",
        "Se ti va, prova a chiamare il 1522. Sono lì per aiutare, davvero.",
        "warm", V3_MODEL_ID, "mode_high", MODE_SALIRE,  # urgent = SALIRE
    ),

    # === Anti-regression: casi ovvi Turbo ===
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

    # === Safe fallback: senza segnale → V3 ===
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

    # === Intensity high ===
    (
        "Gioia forte (has_joy + long) → V3",
        "Che bello! Sono davvero felice per te, dimmi tutto adesso.",
        "warm", V3_MODEL_ID, "intensity_ge_3", MODE_SPECCHIO,
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
