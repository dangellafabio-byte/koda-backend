/**
 * Feedback loop client — Fabio 2026-09-11
 *
 * Privacy: `event_id` è un UUID capability generato lato server per ogni
 * turno. Il client lo riceve nel `meta.event_id` a fine turno e lo tiene
 * SOLO in RAM (in TimelineEntry.event_id). Alla submit del feedback
 * chiama POST /api/feedback con {event_id, feedback_type, category}.
 *
 * Nessun user_id passa mai in questo flow. Il collegamento è unicamente
 * `event_id` che il server risolve per aggiornare il record koda_events.
 */
import Constants from "expo-constants";

const BACKEND_URL: string =
  (Constants?.expoConfig?.extra as any)?.EXPO_BACKEND_URL ||
  process.env.EXPO_PUBLIC_BACKEND_URL ||
  process.env.EXPO_BACKEND_URL ||
  "";

export type FeedbackType = "positive" | "negative";
export type FeedbackCategory =
  | "too_cold"          // 👎 Troppo fredda
  | "too_intense"       // 👎 Troppo intensa
  | "missed_meaning"    // 👎 Non mi ha capito
  | "wrong_moment"      // 👎 Fuori momento
  | "other";            // 👎 Altro

export type FeedbackSubmitResult =
  | { ok: true }
  | { ok: false; status: number; error: string };

/**
 * POST /api/feedback. Idempotente lato server: se il turno è già stato
 * votato, risponde 409 — trattiamo come success silenzioso lato UI.
 */
export async function submitFeedback(
  eventId: string,
  feedbackType: FeedbackType,
  feedbackCategory: FeedbackCategory | null = null,
): Promise<FeedbackSubmitResult> {
  if (!eventId) return { ok: false, status: 0, error: "missing_event_id" };
  if (!BACKEND_URL) return { ok: false, status: 0, error: "no_backend_url" };
  try {
    const res = await fetch(`${BACKEND_URL}/api/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event_id: eventId,
        feedback_type: feedbackType,
        feedback_category: feedbackType === "negative" ? feedbackCategory : null,
      }),
    });
    if (res.ok) return { ok: true };
    // 409 = già votato → non è un errore utente-visibile
    if (res.status === 409) return { ok: true };
    const text = await res.text().catch(() => "");
    return { ok: false, status: res.status, error: text.slice(0, 200) };
  } catch (e: any) {
    return { ok: false, status: 0, error: String(e?.message || e) };
  }
}

export const FEEDBACK_CATEGORY_LABELS: Record<FeedbackCategory, string> = {
  too_cold: "Troppo fredda",
  too_intense: "Troppo intensa",
  missed_meaning: "Non mi ha capito",
  wrong_moment: "Fuori momento",
  other: "Altro",
};
