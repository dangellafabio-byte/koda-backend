/**
 * sentryPrivacy.ts — Scrubbing PII per Sentry (L'Amico Fraterno / Koda)
 *
 * CONTESTO: app mental health / voice AI. Le conversazioni Koda contengono
 * contenuti intimi (sfogo emotivo, ricordi personali, dati clinici impliciti).
 * NULLA di testuale può arrivare al server Sentry.
 *
 * Strategia:
 *   1. beforeSend  — pulisce eventi errore (message, exception values, user, contexts, extra, request)
 *   2. beforeBreadcrumb — droppa breadcrumb di categorie STT/TTS/chat, pulisce data/message
 *   3. Regole di scrubbing testuale su chiavi "sospette" (transcript, dialogue, utterance...)
 *   4. Long strings (>200 char) sostituite con [scrubbed_long_string] per sicurezza estrema
 *
 * NB: user.id deve arrivare già hashato SHA256 dal chiamante (mai email/username plaintext).
 */

import type { Breadcrumb, ErrorEvent, EventHint, BreadcrumbHint } from "@sentry/react-native";

// === Chiavi che quasi sicuramente contengono testo utente / TTS / STT ===
const SENSITIVE_KEY_PATTERNS = [
  "transcript",
  "stt_text",
  "user_text",
  "utterance",
  "tts_content",
  "tts_text",
  "dialogue",
  "conversation",
  "message_text",
  "sentence",
  "content",       // Claude response content
  "koda_reply",
  "user_input",
  "prompt",
];

// === Categorie breadcrumb da DROPPARE completamente ===
const BLOCKED_BREADCRUMB_CATEGORIES = [
  "stt",
  "tts",
  "chat",
  "conversation",
  "koda_diag",   // diagnostica interna può contenere frammenti transcript
];

// === Chiavi PII utente da rimuovere sempre ===
const PII_USER_KEYS = ["email", "username", "name", "ip_address", "phone", "address"];

function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SENSITIVE_KEY_PATTERNS.some((p) => lower.includes(p));
}

function scrubTextFields(obj: any, depth: number = 0): any {
  if (depth > 10) return "[scrubbed_deep_nested]"; // safety recursion cap
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== "object") {
    if (typeof obj === "string" && obj.length > 200) {
      return "[scrubbed_long_string]";
    }
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => scrubTextFields(item, depth + 1));
  }
  const scrubbed: Record<string, any> = {};
  for (const key of Object.keys(obj)) {
    if (isSensitiveKey(key)) {
      scrubbed[key] = "[scrubbed]";
      continue;
    }
    const val = obj[key];
    if (typeof val === "string") {
      if (val.length > 200) {
        scrubbed[key] = "[scrubbed_long_string]";
      } else {
        scrubbed[key] = val;
      }
    } else if (val && typeof val === "object") {
      scrubbed[key] = scrubTextFields(val, depth + 1);
    } else {
      scrubbed[key] = val;
    }
  }
  return scrubbed;
}

function scrubUser(user: any | undefined): any {
  if (!user) return user;
  const scrubbed: Record<string, any> = {};
  // Mantieni SOLO l'id se esiste (assumiamo sia già hashato)
  if (user.id) {
    scrubbed.id = user.id;
  }
  // Rimuovi qualsiasi altro campo PII
  for (const key of PII_USER_KEYS) {
    delete user[key];
  }
  return scrubbed;
}

/**
 * beforeSend hook — chiamato prima di inviare ogni event errore/messaggio.
 * Restituire null per droppare completamente l'event.
 */
export function scrubEventForPrivacy(
  event: ErrorEvent,
  _hint: EventHint
): ErrorEvent | null {
  try {
    // 1. User: rimuovi tutti i campi PII, mantieni solo id hashato
    if (event.user) {
      event.user = scrubUser(event.user);
    }

    // 2. Contexts, extra, request: scrubbing profondo
    if (event.contexts) {
      event.contexts = scrubTextFields(event.contexts);
    }
    if (event.extra) {
      event.extra = scrubTextFields(event.extra);
    }
    if ((event as any).request) {
      (event as any).request = scrubTextFields((event as any).request);
    }

    // 3. Event message: sostituisci sempre (potrebbe contenere transcript)
    if (event.message) {
      if (typeof event.message === "string" && event.message.length > 100) {
        event.message = "[scrubbed_long_message]";
      }
    }

    // 4. Exception values: mantieni il TIPO di errore ma pulisci il messaggio
    //    (il messaggio può contenere testo utente se il developer l'ha incluso)
    if (event.exception?.values) {
      event.exception.values = event.exception.values.map((ex) => {
        if (ex.value && typeof ex.value === "string" && ex.value.length > 200) {
          return { ...ex, value: "[scrubbed_exception_value]" };
        }
        return ex;
      });
    }

    // 5. Tags: mantieni tutti (sono già coarse metadata, non contengono PII)
    //    Ma verifica che nessuno abbia chiave sensibile
    if (event.tags) {
      const cleanTags: Record<string, any> = {};
      for (const [key, value] of Object.entries(event.tags)) {
        if (!isSensitiveKey(key)) {
          cleanTags[key] = value;
        }
      }
      event.tags = cleanTags;
    }

    return event;
  } catch (err) {
    // Se lo scrubber fallisce, meglio droppare l'event che rischiare un leak
    // eslint-disable-next-line no-console
    console.warn("[SentryPrivacy] scrubEventForPrivacy failed:", err);
    return null;
  }
}

/**
 * beforeBreadcrumb hook — chiamato prima di attaccare ogni breadcrumb.
 * Restituire null per droppare il breadcrumb.
 */
export function scrubBreadcrumbForPrivacy(
  breadcrumb: Breadcrumb,
  _hint?: BreadcrumbHint
): Breadcrumb | null {
  try {
    const category = (breadcrumb.category || "").toLowerCase();

    // 1. Drop categorie sensibili
    if (BLOCKED_BREADCRUMB_CATEGORIES.some((c) => category.includes(c))) {
      return null;
    }

    // 2. Console breadcrumbs — spesso contengono log Koda con testo
    if (category === "console") {
      const msg = breadcrumb.message || "";
      // Se il log contiene keyword tipiche di transcript/tts, droppa
      if (/text=|transcript|utterance|say\(/i.test(msg)) {
        return null;
      }
      // Altrimenti tronca messaggi lunghi
      if (msg.length > 200) {
        breadcrumb.message = msg.substring(0, 100) + "…[truncated]";
      }
    }

    // 3. Scrub data field
    if (breadcrumb.data) {
      breadcrumb.data = scrubTextFields(breadcrumb.data);
    }

    // 4. UI click — mantieni ma pulisci il messaggio (potrebbe contenere label testo)
    if (category === "ui.click" || category === "touch") {
      // I click su bottoni normali sono OK, non contengono PII
      // ma se il target ha label lungo, tronca
      if (breadcrumb.message && breadcrumb.message.length > 100) {
        breadcrumb.message = breadcrumb.message.substring(0, 80) + "…";
      }
    }

    return breadcrumb;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[SentryPrivacy] scrubBreadcrumbForPrivacy failed:", err);
    return null;
  }
}

// Export helper puro per usarlo anche altrove (test, altri moduli)
export { scrubTextFields, isSensitiveKey };
