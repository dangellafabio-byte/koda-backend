/**
 * Feedback loop client v2 — Fabio 2026-09-11.
 *
 * Design semplificato:
 *   - SOLO feedback negativo (silenzio = positivo)
 *   - 2 categorie: wrong_content, wrong_delivery
 *   - Nessun tap positivo esplicito
 *
 * Privacy: `event_id` è un UUID capability generato lato server per ogni
 * turno. Il client lo tiene SOLO in RAM. Alla submit chiama POST
 * /api/feedback con {event_id, feedback_type, feedback_category}.
 * Nessun user_id passa mai in questo flow.
 */
import Constants from "expo-constants";

const BACKEND_URL: string =
  (Constants?.expoConfig?.extra as any)?.EXPO_BACKEND_URL ||
  process.env.EXPO_PUBLIC_BACKEND_URL ||
  process.env.EXPO_BACKEND_URL ||
  "";

export type FeedbackType = "negative";  // unico valore ammesso in v2
export type FeedbackCategory =
  | "wrong_content"    // Cosa ha detto — contenuto sbagliato/fuori tema
  | "wrong_delivery";  // Come l'ha detto — tono/modo/lentezza/tempismo

export type FeedbackSubmitResult =
  | { ok: true }
  | { ok: false; status: number; error: string };

/**
 * POST /api/feedback. Idempotente lato server: 409 = già votato → trattato
 * come success silenzioso lato UI.
 */
export async function submitFeedback(
  eventId: string,
  feedbackCategory: FeedbackCategory,
): Promise<FeedbackSubmitResult> {
  if (!eventId) return { ok: false, status: 0, error: "missing_event_id" };
  if (!BACKEND_URL) return { ok: false, status: 0, error: "no_backend_url" };
  try {
    const res = await fetch(`${BACKEND_URL}/api/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event_id: eventId,
        feedback_type: "negative",
        feedback_category: feedbackCategory,
      }),
    });
    if (res.ok) return { ok: true };
    if (res.status === 409) return { ok: true };
    const text = await res.text().catch(() => "");
    return { ok: false, status: res.status, error: text.slice(0, 200) };
  } catch (e: any) {
    return { ok: false, status: 0, error: String(e?.message || e) };
  }
}

export const FEEDBACK_CATEGORY_LABELS: Record<FeedbackCategory, string> = {
  wrong_content: "Cosa ha detto",
  wrong_delivery: "Come l'ha detto",
};

export const FEEDBACK_CATEGORY_DESCRIPTIONS: Record<FeedbackCategory, string> = {
  wrong_content: "contenuto sbagliato / fuori tema",
  wrong_delivery: "tono, modo, tempismo",
};
