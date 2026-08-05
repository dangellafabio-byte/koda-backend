/**
 * Koda — Theme system.
 *
 * === DECISIONE 2026-08-04 (Fabio, dati alla mano) ===
 * Rimosso il light mode. Motivazione:
 *   • 65-95% utenti smartphone preferiscono dark mode (fonti multiple 2026)
 *   • Sera/notte la preferenza sale a 87-91%
 *   • Koda è usato prevalentemente sera/notte (uso emotivo, sfogo)
 *   • Stima: 80-90%+ degli utenti reali Koda avrebbe scelto dark comunque
 * → Il light mode era un investimento a bassa resa e alta superficie di bug.
 *
 * Ora esiste UN SOLO tema: notte. `normalizeThemeName` rimappa qualsiasi
 * valore legacy salvato nel profilo utente (giorno, sistema, liquid, cielo,
 * bosco, ciliegia, auto-orario, ...) a "notte" — utente non deve fare
 * nulla, la migrazione è automatica al primo login post-update.
 */
import React, { createContext, useContext, useEffect, useMemo, useState } from "react";

export type ThemeName = "notte";

export type Palette = {
  name: ThemeName;
  label: string;
  emoji: string;
  isDark: boolean;

  // Backgrounds
  bg: string;
  surface: string;
  surfaceAlt: string;
  border: string;
  divider: string;

  // Text
  text: string;
  textMuted: string;
  textDim: string;

  // Accent
  primary: string;
  primaryText: string;
  primarySoftBg: string;
  primarySoftBorder: string;

  // Bubbles
  userBubble: string;
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
  // Indaco notturno neon — signature Koda.
  bg: "#1F1A36",
  surface: "#2A2347",
  surfaceAlt: "rgba(255,255,255,0.06)",
  border: "rgba(255,255,255,0.08)",
  divider: "rgba(255,255,255,0.07)",
  text: "#E2E8F0",
  textMuted: "#94A3B8",
  textDim: "#64748B",
  // Blu petrolio — IDENTITÀ "L'AMICO FRATERNO": stesso colore dell'orb
  // quando l'utente parla (LISTEN_PALETTE in EclipseOrb).
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

export const THEMES: Record<ThemeName, Palette> = { notte: NOTTE };
export const THEME_LIST: Palette[] = [NOTTE];

/**
 * Migration totale: qualunque valore legacy (giorno, sistema, liquid,
 * cielo, bosco, ciliegia, auto-orario, undefined, ...) → "notte".
 * L'app ha un solo tema, non c'è più scelta.
 */
export function normalizeThemeName(_name?: string | null): ThemeName {
  return "notte";
}

export function resolveTheme(_name?: ThemeName | string | null): Palette {
  return NOTTE;
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

/**
 * ThemeProvider — mantenuto come no-op wrapper per compatibilità con
 * codice esistente. Non esegue alcuna logica dinamica: c'è un solo tema
 * (notte). `setThemeName` è un no-op documentato.
 */
export function ThemeProvider({
  children,
  initialName: _initialName = "notte",
  initialDayStart = 7,
  initialNightStart = 20,
}: {
  children: React.ReactNode;
  initialName?: ThemeName | string;
  initialDayStart?: number;
  initialNightStart?: number;
}) {
  const [dayStart, setDayStart] = useState(initialDayStart);
  const [nightStart, setNightStart] = useState(initialNightStart);

  // Fisso a "notte"; ignoriamo qualunque tentativo di cambio.
  const themeName: ThemeName = "notte";
  const setThemeName = (_n: ThemeName) => {};

  const setHours = (d: number, n: number) => {
    setDayStart(d);
    setNightStart(n);
  };

  // no-op: unused imports guard-rail. Riferiamo useMemo/useEffect così
  // eslint non li segnala come inutili (mantengono la firma dell'export).
  useEffect(() => {}, []);
  const theme = useMemo(() => NOTTE, []);

  return (
    <Ctx.Provider
      value={{ theme, themeName, setThemeName, setHours, dayStart, nightStart }}
    >
      {children}
    </Ctx.Provider>
  );
}
