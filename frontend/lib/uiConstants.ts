/**
 * lib/uiConstants.ts — SINGLE SOURCE OF TRUTH per gli sfondi standard.
 * -----------------------------------------------------------------------------
 * v67.8 (Fabio 2026-06-24, DOCUMENTO UNICO Sezione 1)
 *
 * REGOLA (Fabio): tutte le schermate standard dell'app devono usare
 * lo STESSO identico sfondo Indigo. Esiste UNA SOLA eccezione documentata:
 * "Lascia Andare" usa il tema "cosmic space" (nero profondo con un'ombra
 * di indaco molto scuro) per rimarcare l'uscita simbolica dall'ordinario.
 *
 * ❗ Non introdurre nuove varianti di sfondo (niente #0B1220, #0F0C1C,
 *    #08070A, #0b0f1a…). Se un design nuovo richiede una variante,
 *    documentarla QUI, altrimenti usare APP_BG_INDIGO.
 */

/** Sfondo standard — IDENTITÀ Ollenya in TUTTE le schermate. */
export const APP_BG_INDIGO = "#1F1A36";

/** Sfondo "cosmic space" — eccezione documentata per Lascia Andare.
 *  Indaco quasi-nero, un gradino più scuro di APP_BG per separare
 *  simbolicamente la "stanza dello sfogo" dal resto dell'app. */
export const COSMIC_SPACE_BG = "#06060E";

/** Overlay più scuro (semitrasparente) per modali / backdrop. */
export const APP_BG_INDIGO_DEEP = "#15122A";
