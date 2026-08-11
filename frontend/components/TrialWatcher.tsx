/**
 * TrialWatcher — Componente globale montato in _layout.tsx dopo AuthGate.
 *
 * Cosa fa (spec Fabio 2026-08-10):
 *   1. All'attivazione (utente loggato) fa un fetch iniziale di
 *      /api/trial/state per conoscere lo stato del trial.
 *   2. Fa polling ogni 30 secondi mentre l'app è in foreground.
 *   3. Se lo stato diventa "expired" mostra il <TrialExpiredOverlay>
 *      bloccante con CTA verso /paywall.
 *   4. Ricontrolla immediatamente allo switch foreground (utente torna
 *      dal background dopo tanto tempo → potrebbe essere scaduta la
 *      finestra 5 giorni).
 *   5. Se l'utente naviga a /paywall, il polling continua ma l'overlay
 *      viene nascosto (l'utente è già nella schermata piani).
 *
 * Cosa NON fa:
 *   - Non conta minuti né tempo. Fonte di verità unica = backend.
 *   - Non conosce prezzi, nomi piani, CTA testuali per i piani.
 *   - Non blocca il rendering dei figli — è un wrapper trasparente
 *     che mostra l'overlay SOPRA tutto quando serve.
 *
 * Comportamento in offline:
 *   - Fetch fallisce → mantiene l'ultimo stato noto (default "active"
 *     al primo boot se rete già assente). Zero overlay in caso di
 *     mancata rete: l'esperienza degrada gracefully.
 */
import React, { useEffect, useRef, useState } from "react";
import { AppState, AppStateStatus } from "react-native";
import { usePathname } from "expo-router";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import TrialExpiredOverlay from "./TrialExpiredOverlay";

const TAG = "KODA_TRIAL_WATCHER";
const POLL_INTERVAL_MS = 30_000; // 30 secondi
const INITIAL_DELAY_MS = 1500;   // aspetta che l'app sia caricata prima del primo fetch

type TrialState = "active" | "closing" | "expired";

type Props = {
  children: React.ReactNode;
};

export default function TrialWatcher({ children }: Props) {
  const { user } = useAuth();
  const pathname = usePathname();
  const [trialState, setTrialState] = useState<TrialState>("active");
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const fetchState = async () => {
    if (!mountedRef.current) return;
    try {
      const res = await api.getTrialState();
      const next: TrialState = res?.trial_state ?? "active";
      if (!mountedRef.current) return;
      setTrialState((prev) => {
        if (prev !== next) {
          console.log(`[${TAG}] state change: ${prev} → ${next}`);
        }
        return next;
      });
    } catch {
      // Silenzio in offline / errore rete. Manteniamo l'ultimo stato.
      // Non spammiamo warn per ogni poll fallito.
    }
  };

  const startPolling = () => {
    if (pollTimerRef.current) return;
    pollTimerRef.current = setInterval(fetchState, POLL_INTERVAL_MS);
  };

  const stopPolling = () => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  };

  // Effetto principale: attiva/disattiva polling in base a auth + app state
  useEffect(() => {
    if (!user) {
      // Utente non loggato: niente polling, reset a active come safe default
      stopPolling();
      setTrialState("active");
      return;
    }

    console.log(`[${TAG}] auth ok, starting trial polling (${POLL_INTERVAL_MS}ms)`);

    // Fetch iniziale ritardato per non competere col boot dell'app
    const initialTimer = setTimeout(() => {
      fetchState();
    }, INITIAL_DELAY_MS);

    // Polling periodico
    startPolling();

    // Foreground/background: al ritorno in foreground rifacciamo subito il
    // check (potrebbe essere passato molto tempo e la finestra 5gg potrebbe
    // essere scaduta durante il background).
    let currentAppState: AppStateStatus = AppState.currentState;
    const appStateSub = AppState.addEventListener("change", (next) => {
      const wasBackground = currentAppState !== "active";
      currentAppState = next;
      if (next === "active" && wasBackground) {
        console.log(`[${TAG}] foreground resume: immediate trial state re-check`);
        fetchState();
        startPolling();
      } else if (next !== "active") {
        stopPolling();
      }
    });

    return () => {
      clearTimeout(initialTimer);
      stopPolling();
      appStateSub.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  // L'overlay è bloccante quando trialState === "expired", MA nascosto se
  // l'utente sta già navigando in /paywall (per non impedirgli di vedere
  // i piani e completare l'acquisto).
  const isOnPaywall = (pathname ?? "").startsWith("/paywall");
  const showOverlay = trialState === "expired" && !isOnPaywall;

  return (
    <>
      {children}
      <TrialExpiredOverlay
        visible={showOverlay}
        onDismiss={() => {
          // Nessun cambio di stato locale: il polling continuerà a
          // ricontrollare, e se l'utente completa l'acquisto il backend
          // ritornerà "active" → l'overlay sparisce da solo. Se l'acquisto
          // fallisce e resta in expired, l'overlay torna al ritorno dalla
          // schermata paywall.
        }}
      />
    </>
  );
}
