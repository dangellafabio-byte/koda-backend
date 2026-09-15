/**
 * freeCountdown.ts — Helper countdown Free tier (v65.53, Fabio 2026-06)
 *
 * Formato coerente con `backend/free_tier_gate.format_countdown_it`:
 *   - < 2 min:  "puoi riprovare tra poco"
 *   - < 1 ora:  "tra 42 minuti"
 *   - < 24 ore: "tra 6 ore"
 *   - >= 24 ore: "tra 2 giorni e 3 ore" (senza "0 giorni" o "0 ore")
 *
 * Non usare mai formati "0 giorni e X ore" o "0 ore e X minuti".
 * Rispetta concordanza singolare/plurale IT (minuto/minuti, ora/ore,
 * giorno/giorni).
 */
import { useEffect, useState } from "react";

export function formatCountdownIt(secondsRemaining: number | null | undefined): string {
  if (secondsRemaining == null || secondsRemaining < 0) return "tra poco";
  if (secondsRemaining < 120) return "puoi riprovare tra poco";
  const minutes = Math.floor(secondsRemaining / 60);
  if (minutes < 60) {
    return `tra ${minutes} minut${minutes === 1 ? "o" : "i"}`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `tra ${hours} or${hours === 1 ? "a" : "e"}`;
  }
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  if (remHours === 0) {
    return `tra ${days} giorn${days === 1 ? "o" : "i"}`;
  }
  return (
    `tra ${days} giorn${days === 1 ? "o" : "i"} e ` +
    `${remHours} or${remHours === 1 ? "a" : "e"}`
  );
}

/**
 * Hook: countdown live che si aggiorna automaticamente.
 * - Se >24h: refresh ogni 10 minuti (batteria-friendly)
 * - Se 1-24h: refresh ogni 5 minuti
 * - Se <1h: refresh ogni 20s
 * Ritorna il testo formattato aggiornato.
 */
export function useLiveCountdown(periodEndsAtIso: string | null | undefined): string | null {
  const [text, setText] = useState<string | null>(() => {
    if (!periodEndsAtIso) return null;
    const target = new Date(periodEndsAtIso).getTime();
    const now = Date.now();
    return formatCountdownIt(Math.max(0, Math.floor((target - now) / 1000)));
  });

  useEffect(() => {
    if (!periodEndsAtIso) {
      setText(null);
      return;
    }
    let cancelled = false;

    const compute = () => {
      if (cancelled) return { sec: 0, txt: null };
      const target = new Date(periodEndsAtIso).getTime();
      const now = Date.now();
      const sec = Math.max(0, Math.floor((target - now) / 1000));
      const txt = formatCountdownIt(sec);
      return { sec, txt };
    };

    const { sec: initSec, txt: initTxt } = compute();
    setText(initTxt);
    if (initSec <= 0) return () => { cancelled = true; };

    // Scelta interval basata sul tempo residuo
    const pickInterval = (sec: number): number => {
      if (sec > 24 * 3600) return 10 * 60 * 1000; // 10 min
      if (sec > 3600) return 5 * 60 * 1000;        // 5 min
      return 20 * 1000;                            // 20s
    };

    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = () => {
      if (cancelled) return;
      const { sec, txt } = compute();
      setText(txt);
      if (sec <= 0) return;
      timer = setTimeout(tick, pickInterval(sec));
    };
    timer = setTimeout(tick, pickInterval(initSec));

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [periodEndsAtIso]);

  return text;
}
