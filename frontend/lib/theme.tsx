/**
 * Koda — Theme system.
 *
 * Cleanup 2026-08-04: rimossi i temi legacy LIQUID / CIELO / BOSCO / CILIEGIA
 * (non selezionabili dall'UI da mesi, ma ancora attivi via profilo legacy →
 * causavano bug di sfondo persistente). Ora sopravvivono solo:
 *   - "giorno" (Chiaro ☀️)
 *   - "notte"  (Scuro 🌙)
 *   - "auto-orario" (alterna in base all'ora reale)
 *
 * `resolveTheme` include una **migration** che rimappa qualsiasi valore
 * legacy (liquid/cielo/bosco/ciliegia/sistema/altro) a "giorno". Zero
 * intervento richiesto sull'utente: al primo login post-update, il tema
 * risolto è coerente con l'UI del selettore.
 */
import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import { Appearance } from "react-native";

export type ThemeName = "notte" | "giorno" | "auto-orario";

export type Palette = {
  name: ThemeName;
  label: string;
  emoji: string;
  isDark: boolean;

  // Backgrounds
  bg: string;          // app background
  surface: string;     // cards, modals
  surfaceAlt: string;  // subtle alt (toggles, fields)
  border: string;      // hairline borders
  divider: string;     // separators

  // Text
  text: string;        // primary text
  textMuted: string;   // secondary text
  textDim: string;     // tertiary / placeholders / hints

  // Accent (the brand colour for the active theme)
  primary: string;
  primaryText: string;       // text drawn on top of primary
  primarySoftBg: string;     // softer backdrop using primary tint
  primarySoftBorder: string;

  // Bubbles
  userBubble: string;        // user message bubble bg
  userBubbleText: string;
  aiBubbleBg: string;
  aiBubbleBorder: string;
  aiBubbleText: string;

  // Status
  success: string;
  warning: string;
  danger: string;

  // Tones
  tone: {
    neutral: { bg: string; border: string };
    calm: { bg: string; border: string };
    warm: { bg: string; border: string };
    energetic: { bg: string; border: string };
    concerned: { bg: string; border: string };
    urgent: { bg: string; border: string };
  };
};

const NOTTE: Palette = {
  name: "notte",
  label: "Scuro",
  emoji: "🌙",
  isDark: true,
  // === FIX 2026-06 (richiesta utente) ===
  // Notte = indaco notturno neon profondo. Sostituisce il vecchio
  // #0B0F1A (quasi nero) con una tinta "cyber-neon night" più calda
  // e visivamente connotata, in famiglia con i palette neon dell'orb.
  bg: "#1F1A36",
  surface: "#2A2347",
  surfaceAlt: "rgba(255,255,255,0.06)",
  border: "rgba(255,255,255,0.08)",
  divider: "rgba(255,255,255,0.07)",
  text: "#E2E8F0",
  textMuted: "#94A3B8",
  textDim: "#64748B",
  // === IDENTITÀ "L'AMICO FRATERNO" ===
  // Il primary è il "blu petrolio" — esattamente lo stesso colore che
  // l'Eclissi assume quando l'utente parla (LISTEN_PALETTE in EclipseOrb).
  // Così il bubble dell'utente e l'orb durante la registrazione sono
  // visivamente la stessa cosa: "questo sono io che parlo". Questa è la
  // signature visiva dell'app — riconoscibile a colpo d'occhio.
  primary: "#0E7C7B",
  primaryText: "#FFFFFF",
  primarySoftBg: "rgba(14,124,123,0.14)",
  primarySoftBorder: "rgba(14,124,123,0.5)",
  userBubble: "#0E7C7B",
  userBubbleText: "#FFFFFF",
  aiBubbleBg: "rgba(148,163,184,0.10)",
  aiBubbleBorder: "rgba(148,163,184,0.35)",
  aiBubbleText: "#E2E8F0",
  success: "#34D399",
  warning: "#F59E0B",
  danger: "#F87171",
  tone: {
    neutral: { bg: "rgba(148,163,184,0.10)", border: "rgba(148,163,184,0.35)" },
    calm: { bg: "rgba(56,189,248,0.10)", border: "rgba(56,189,248,0.4)" },
    warm: { bg: "rgba(251,191,36,0.10)", border: "rgba(251,191,36,0.4)" },
    energetic: { bg: "rgba(34,197,94,0.10)", border: "rgba(34,197,94,0.4)" },
    concerned: { bg: "rgba(249,115,22,0.10)", border: "rgba(249,115,22,0.45)" },
    urgent: { bg: "rgba(239,68,68,0.12)", border: "rgba(239,68,68,0.5)" },
  },
};

const GIORNO: Palette = {
  name: "giorno",
  label: "Chiaro",
  emoji: "☀️",
  // === FIX 2026-06-29 v37 — TEMA "GIORNO-NEGATIVO" ===
  // Riprogettazione completa: invece di un grigio neutro (problemi di
  // contrasto + estraneità al mood Koda), il tema giorno diventa un
  // "negativo fotografico" del tema notte. Stessa struttura emotiva,
  // luminanza invertita: testo indaco (esattamente il colore dello
  // sfondo notte). Mantiene la signature teal-petrolio (#0E7C7B) e il
  // bordeaux della Stanza dello Sfogo (#7A1F2E), che funzionano su
  // entrambi gli sfondi.
  // === TWEAK 2026-08-04 — "Pietra Serena" ===
  // Fabio: il crema #F4F2E8 era troppo "carta antica". Passiamo a un
  // grigio-caldo tipo pietra toscana, che ha ancora sottotono beige
  // (evita stridore col champagne dell'orb/border) ma senza sembrare
  // beige. Surface allineato per coerenza tonale delle card.
  isDark: false,
  bg: "#DDD7CB",
  surface: "#CBC4B7",
  surfaceAlt: "rgba(31,26,54,0.06)",
  border: "rgba(31,26,54,0.10)",
  divider: "rgba(31,26,54,0.08)",
  text: "#1F1A36",
  textMuted: "rgba(31,26,54,0.65)",
  textDim: "rgba(31,26,54,0.42)",
  primary: "#0E7C7B",
  primaryText: "#FFFFFF",
  primarySoftBg: "rgba(14,124,123,0.12)",
  primarySoftBorder: "rgba(14,124,123,0.45)",
  userBubble: "#0E7C7B",
  userBubbleText: "#FFFFFF",
  aiBubbleBg: "rgba(31,26,54,0.06)",
  aiBubbleBorder: "rgba(31,26,54,0.16)",
  aiBubbleText: "#1F1A36",
  // Stati semantici più saturi/scuri per leggibilità su chiaro
  success: "#16A34A",
  warning: "#D97706",
  danger: "#DC2626",
  tone: {
    neutral: { bg: "rgba(31,26,54,0.08)", border: "rgba(31,26,54,0.18)" },
    calm: { bg: "rgba(14,116,144,0.10)", border: "rgba(14,116,144,0.35)" },
    warm: { bg: "rgba(217,119,6,0.12)", border: "rgba(217,119,6,0.40)" },
    energetic: { bg: "rgba(22,163,74,0.10)", border: "rgba(22,163,74,0.35)" },
    concerned: { bg: "rgba(234,88,12,0.10)", border: "rgba(234,88,12,0.40)" },
    urgent: { bg: "rgba(220,38,38,0.12)", border: "rgba(220,38,38,0.45)" },
  },
};

// Pseudo-palette per il selettore "Auto" — non è un vero tema visivo:
// quando selezionato, themeName diventa "auto-orario" e il ThemeProvider
// alterna GIORNO/NOTTE in base all'ORA REALE del giorno (default 7:00 →
// 20:00 giorno, 20:00 → 7:00 notte). Indipendente dal dark-mode di iOS.
const AUTO_ORARIO_PSEUDO: Palette = {
  ...NOTTE,
  name: "auto-orario",
  label: "Auto",
  emoji: "🔄",
};

export const THEMES: Record<Exclude<ThemeName, "auto-orario">, Palette> = {
  notte: NOTTE,
  giorno: GIORNO,
};

export const THEME_LIST: Palette[] = [GIORNO, NOTTE, AUTO_ORARIO_PSEUDO];

/**
 * Set di temi validi. Qualsiasi valore fuori da qui è considerato legacy
 * e va rimappato a "giorno" (default sicuro chiaro).
 */
const VALID_THEME_NAMES: ReadonlySet<string> = new Set([
  "giorno",
  "notte",
  "auto-orario",
]);

/**
 * Migration: rimappa qualsiasi valore legacy o sconosciuto a "giorno".
 * Necessario perché i profili utente più vecchi possono contenere
 * "liquid", "cielo", "bosco", "ciliegia", "sistema" ecc.
 */
export function normalizeThemeName(name: string | undefined | null): ThemeName {
  if (name && VALID_THEME_NAMES.has(name)) {
    return name as ThemeName;
  }
  return "giorno";
}

export function resolveTheme(name: ThemeName | string | undefined | null): Palette {
  const safe = normalizeThemeName(name as string | undefined | null);
  if (safe === "auto-orario") {
    // Il vero switch giorno/notte è gestito dal Provider con i dayStart/
    // nightStart correnti. Qui torniamo un fallback ragionevole in base
    // all'ora attuale (7:00 → 20:00 giorno).
    const h = new Date().getHours();
    return h >= 7 && h < 20 ? GIORNO : NOTTE;
  }
  return THEMES[safe as Exclude<ThemeName, "auto-orario">];
}

// =================== Context ===================

type ThemeCtx = {
  theme: Palette;
  themeName: ThemeName;
  setThemeName: (n: ThemeName) => void;
  setHours: (dayStart: number, nightStart: number) => void;
  dayStart: number;
  nightStart: number;
};

const Ctx = createContext<ThemeCtx>({
  theme: NOTTE,
  themeName: "notte",
  setThemeName: () => {},
  setHours: () => {},
  dayStart: 7,
  nightStart: 20,
});

export const useTheme = () => useContext(Ctx);

export function ThemeProvider({
  children,
  initialName = "notte",
  initialDayStart = 7,
  initialNightStart = 20,
}: {
  children: React.ReactNode;
  initialName?: ThemeName | string;
  initialDayStart?: number;
  initialNightStart?: number;
}) {
  // Applica la migration già in fase di seed dello state → utenti con
  // profili legacy vedono subito il tema corretto senza flash intermedi.
  const [themeName, _setThemeName] = useState<ThemeName>(
    normalizeThemeName(initialName as string | undefined | null)
  );
  const [systemScheme, setSystemScheme] = useState(Appearance.getColorScheme());
  const [dayStart, setDayStart] = useState(initialDayStart);
  const [nightStart, setNightStart] = useState(initialNightStart);
  const [, setTick] = useState(0);

  // Wrapper: applica sempre la normalizzazione anche a runtime
  // (esempio: setThemeName("liquid") viene rimappato a "giorno").
  const setThemeName = (n: ThemeName | string) =>
    _setThemeName(normalizeThemeName(n as string));

  useEffect(() => {
    const sub = Appearance.addChangeListener((c) => setSystemScheme(c.colorScheme));
    return () => sub.remove();
  }, []);

  // For "auto-orario": tick every minute so the theme switches at the configured hours
  useEffect(() => {
    if (themeName !== "auto-orario") return;
    const id = setInterval(() => setTick((n) => n + 1), 60000);
    return () => clearInterval(id);
  }, [themeName]);

  const theme = useMemo(() => {
    if (themeName === "auto-orario") {
      const h = new Date().getHours();
      const isDay =
        dayStart < nightStart
          ? h >= dayStart && h < nightStart
          : h >= dayStart || h < nightStart;
      return isDay ? GIORNO : NOTTE;
    }
    return THEMES[themeName as Exclude<ThemeName, "auto-orario">] || GIORNO;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [themeName, systemScheme, dayStart, nightStart, /* tick triggers re-render */]);

  const setHours = (d: number, n: number) => {
    setDayStart(d);
    setNightStart(n);
  };

  return (
    <Ctx.Provider
      value={{ theme, themeName, setThemeName, setHours, dayStart, nightStart }}
    >
      {children}
    </Ctx.Provider>
  );
}
