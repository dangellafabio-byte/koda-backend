/**
 * Taccuino Vivo — Theme system.
 * 5 temi semplici + opzione "Sistema" (segue il telefono).
 */
import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import { Appearance } from "react-native";

export type ThemeName = "notte" | "giorno" | "cielo" | "bosco" | "ciliegia" | "sistema" | "auto-orario";

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
  label: "Notte",
  emoji: "🌙",
  isDark: true,
  bg: "#0B0F1A",
  surface: "#101622",
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
  label: "Giorno",
  emoji: "☀️",
  // === FIX 2026-05-25 ===
  // Prima il tema "Giorno" era un puro chiaro (bg #F8FAFC, text #0F172A).
  // Ma molti elementi UI hanno testo bianco hardcoded → su sfondo bianco
  // diventavano INVISIBILI. Refactor completo richiederebbe ore.
  // Soluzione: "Giorno" diventa un tema scuro PIÙ CHIARO della Notte —
  // soft warm slate. Si distingue chiaramente da Notte (visibile la
  // transizione), ma tutti i testi bianchi restano leggibili.
  // Identità mantenuta: signature petrolio per primary, contrasto pulito.
  isDark: true,
  bg: "#1F2937",                         // slate-800 (più chiaro di Notte #0B0F1A)
  surface: "#2D3748",                    // slate-700
  surfaceAlt: "rgba(255,255,255,0.08)",
  border: "rgba(255,255,255,0.10)",
  divider: "rgba(255,255,255,0.08)",
  text: "#F3F4F6",                       // gray-100 (lievemente più chiaro di Notte)
  textMuted: "#CBD5E1",
  textDim: "#94A3B8",
  primary: "#0E7C7B",                    // stesso petrolio della Notte (signature)
  primaryText: "#FFFFFF",
  primarySoftBg: "rgba(14,124,123,0.16)",
  primarySoftBorder: "rgba(14,124,123,0.55)",
  userBubble: "#0E7C7B",
  userBubbleText: "#FFFFFF",
  aiBubbleBg: "rgba(255,255,255,0.07)",
  aiBubbleBorder: "rgba(255,255,255,0.18)",
  aiBubbleText: "#F3F4F6",
  success: "#34D399",
  warning: "#FBBF24",
  danger: "#F87171",
  tone: {
    neutral: { bg: "rgba(203,213,225,0.10)", border: "rgba(203,213,225,0.35)" },
    calm: { bg: "rgba(96,165,250,0.10)", border: "rgba(96,165,250,0.4)" },
    warm: { bg: "rgba(252,211,77,0.12)", border: "rgba(252,211,77,0.45)" },
    energetic: { bg: "rgba(74,222,128,0.10)", border: "rgba(74,222,128,0.4)" },
    concerned: { bg: "rgba(251,146,60,0.10)", border: "rgba(251,146,60,0.45)" },
    urgent: { bg: "rgba(248,113,113,0.12)", border: "rgba(248,113,113,0.5)" },
  },
};

const CIELO: Palette = {
  name: "cielo",
  label: "Cielo",
  emoji: "💙",
  isDark: false,
  bg: "#F0F9FF",
  surface: "#FFFFFF",
  surfaceAlt: "#E0F2FE",
  border: "#BAE6FD",
  divider: "#E0F2FE",
  text: "#0C4A6E",
  textMuted: "#0369A1",
  textDim: "#7DD3FC",
  primary: "#0284C7",
  primaryText: "#FFFFFF",
  primarySoftBg: "#E0F2FE",
  primarySoftBorder: "#7DD3FC",
  userBubble: "#0284C7",
  userBubbleText: "#FFFFFF",
  aiBubbleBg: "#FFFFFF",
  aiBubbleBorder: "#BAE6FD",
  aiBubbleText: "#0C4A6E",
  success: "#16A34A",
  warning: "#D97706",
  danger: "#DC2626",
  tone: {
    neutral: { bg: "#F1F5F9", border: "#CBD5E1" },
    calm: { bg: "#E0F2FE", border: "#7DD3FC" },
    warm: { bg: "#FEF3C7", border: "#FCD34D" },
    energetic: { bg: "#DCFCE7", border: "#86EFAC" },
    concerned: { bg: "#FFEDD5", border: "#FDBA74" },
    urgent: { bg: "#FEE2E2", border: "#FCA5A5" },
  },
};

const BOSCO: Palette = {
  name: "bosco",
  label: "Bosco",
  emoji: "🌿",
  isDark: false,
  bg: "#F0FDF4",
  surface: "#FFFFFF",
  surfaceAlt: "#DCFCE7",
  border: "#BBF7D0",
  divider: "#DCFCE7",
  text: "#14532D",
  textMuted: "#166534",
  textDim: "#86EFAC",
  primary: "#16A34A",
  primaryText: "#FFFFFF",
  primarySoftBg: "#DCFCE7",
  primarySoftBorder: "#86EFAC",
  userBubble: "#16A34A",
  userBubbleText: "#FFFFFF",
  aiBubbleBg: "#FFFFFF",
  aiBubbleBorder: "#BBF7D0",
  aiBubbleText: "#14532D",
  success: "#16A34A",
  warning: "#D97706",
  danger: "#DC2626",
  tone: {
    neutral: { bg: "#F1F5F9", border: "#CBD5E1" },
    calm: { bg: "#E0F2FE", border: "#7DD3FC" },
    warm: { bg: "#FEF3C7", border: "#FCD34D" },
    energetic: { bg: "#DCFCE7", border: "#86EFAC" },
    concerned: { bg: "#FFEDD5", border: "#FDBA74" },
    urgent: { bg: "#FEE2E2", border: "#FCA5A5" },
  },
};

const CILIEGIA: Palette = {
  name: "ciliegia",
  label: "Ciliegia",
  emoji: "🌸",
  isDark: false,
  bg: "#FFF1F2",
  surface: "#FFFFFF",
  surfaceAlt: "#FFE4E6",
  border: "#FECDD3",
  divider: "#FFE4E6",
  text: "#881337",
  textMuted: "#9F1239",
  textDim: "#FB7185",
  primary: "#E11D48",
  primaryText: "#FFFFFF",
  primarySoftBg: "#FFE4E6",
  primarySoftBorder: "#FDA4AF",
  userBubble: "#E11D48",
  userBubbleText: "#FFFFFF",
  aiBubbleBg: "#FFFFFF",
  aiBubbleBorder: "#FECDD3",
  aiBubbleText: "#881337",
  success: "#16A34A",
  warning: "#D97706",
  danger: "#DC2626",
  tone: {
    neutral: { bg: "#F1F5F9", border: "#CBD5E1" },
    calm: { bg: "#E0F2FE", border: "#7DD3FC" },
    warm: { bg: "#FEF3C7", border: "#FCD34D" },
    energetic: { bg: "#DCFCE7", border: "#86EFAC" },
    concerned: { bg: "#FFEDD5", border: "#FDBA74" },
    urgent: { bg: "#FEE2E2", border: "#FCA5A5" },
  },
};

export const THEMES: Record<Exclude<ThemeName, "sistema">, Palette> = {
  notte: NOTTE,
  giorno: GIORNO,
  cielo: CIELO,
  bosco: BOSCO,
  ciliegia: CILIEGIA,
};

export const THEME_LIST: Palette[] = [GIORNO, NOTTE, CIELO, BOSCO, CILIEGIA];

export function resolveTheme(name: ThemeName | undefined | null): Palette {
  if (!name || name === "sistema") {
    const sysDark = Appearance.getColorScheme() === "dark";
    return sysDark ? NOTTE : GIORNO;
  }
  return THEMES[name] || NOTTE;
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
  initialName?: ThemeName;
  initialDayStart?: number;
  initialNightStart?: number;
}) {
  const [themeName, setThemeName] = useState<ThemeName>(initialName);
  const [systemScheme, setSystemScheme] = useState(Appearance.getColorScheme());
  const [dayStart, setDayStart] = useState(initialDayStart);
  const [nightStart, setNightStart] = useState(initialNightStart);
  const [, setTick] = useState(0);

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
    if (themeName === "sistema") {
      return systemScheme === "dark" ? NOTTE : GIORNO;
    }
    if (themeName === "auto-orario") {
      const h = new Date().getHours();
      const isDay =
        dayStart < nightStart
          ? h >= dayStart && h < nightStart
          : h >= dayStart || h < nightStart;
      return isDay ? GIORNO : NOTTE;
    }
    return THEMES[themeName as Exclude<ThemeName, "sistema" | "auto-orario">] || NOTTE;
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
