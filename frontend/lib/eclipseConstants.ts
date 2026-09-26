/**
 * lib/eclipseConstants.ts — SINGLE SOURCE OF TRUTH per le dimensioni eclissi.
 * -----------------------------------------------------------------------------
 * v67.3 (Fabio 2026-06-24)
 *
 * REGOLA D'ORO (Fabio):
 *   Esiste un solo set di dimensioni standard per l'eclissi, valido in
 *   OGNI schermata dell'app: Splash, Intro, Home, Free, Premium, Lascia
 *   Andare, post-pagamento. Nessuna variazione tra schermate.
 *
 * VALORI SCELTI (compat iPhone SE 320×568):
 *   • NUCLEUS = 200 px  — diametro del NUCLEO NERO. Fisso in ogni stato
 *                          e in ogni schermata. Non cambia mai.
 *   • MIN     = 240 px  — diametro dell'orb quando il glow è al minimo
 *                          (idle/riposo). Nucleo + 20px di aurora per lato.
 *   • MAX     = 320 px  — diametro dell'orb quando il glow è al massimo
 *                          (speaking/listening peak, e cap ratchet Lascia
 *                          Andare). Nucleo + 60px di aurora per lato.
 *
 * Tra stati (idle/listening/thinking/speaking) può cambiare SOLO:
 *   • Il colore del glow (tone-based)
 *   • L'intensità/dimensione del glow entro il range [MIN, MAX]
 * Il nucleo nero NON cambia mai.
 *
 * Lascia Andare (eccezione documentata):
 *   • Il nucleo resta fisso a NUCLEUS.
 *   • Il glow parte a MIN e cresce cumulativamente fino a MAX in base
 *     al tempo di parlato sopra soglia (ratchet monotono).
 */

/** Diametro del nucleo nero centrale. Fisso in ogni schermata e stato. */
export const ECLIPSE_NUCLEUS_DIAMETER = 200;

/** Diametro totale dell'orb quando il glow è al minimo (idle). */
export const ECLIPSE_MIN_DIAMETER = 240;

/** Diametro totale dell'orb quando il glow è al massimo (speaking peak). */
export const ECLIPSE_MAX_DIAMETER = 320;

/** Rapporto nucleo/aurora max — usato internamente da EclipseOrb.
 *  200/320 = 0.625 → il nucleo occupa il 62.5% del diametro totale al max. */
export const ECLIPSE_NUCLEUS_RATIO = ECLIPSE_NUCLEUS_DIAMETER / ECLIPSE_MAX_DIAMETER;
