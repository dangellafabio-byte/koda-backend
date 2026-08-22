/**
 * speechPermission — helper condiviso per Speech Recognition + Microfono.
 * Fabio 2026-08-22.
 *
 * ⚠️  UNICO entry point per QUALUNQUE richiesta di permesso Speech
 * Recognition/Microfono in tutta l'app. Riusato da:
 *   - IntroPremium (Passo 3.5)
 *   - Home Koda conv (tap orb, toggle hands-free)
 *   - KodaIntroV3 (setup vocale)
 *
 * Testo del pre-prompt IDENTICO ovunque per coerenza rituale — se lo
 * cambi qui, cambia in un solo posto per tutta l'app.
 *
 * Comportamento (spec Fabio):
 *   1. Se già granted → return subito, nessun attrito
 *   2. Se undetermined o denied+canAskAgain=true:
 *      → Alert pre-prompt "Un attimo / Per parlarti serve che io ti
 *        capisca davvero. Un permesso in più, poi si parte."
 *      → [Non ora] cancel / [OK] richiama dialog sistema
 *   3. Se denied+canAskAgain=false (permesso definitivamente negato):
 *      → Alert fallback con [Apri Impostazioni] → Linking.openSettings()
 *
 * NB: il flow "Non ora / OK" è pensato per essere ri-chiamato ogni volta
 * che l'utente prova a parlare (tap orb, hands-free) — non è un one-shot.
 * Se l'utente ha detto "no" all'intro, alla prima interazione voice sulla
 * home vera ripartirà lo stesso pre-prompt.
 */
import { Alert, Linking, Platform } from "react-native";
import { ExpoSpeechRecognitionModule } from "expo-speech-recognition";

const TAG = "[speechPermission]";

// === TESTO PRE-PROMPT (single source of truth, rituale) =================
const PRE_PROMPT_TITLE = "Un attimo";
const PRE_PROMPT_BODY =
  "Per parlarti serve che io ti capisca davvero. Un permesso in più, poi si parte.";
const SETTINGS_BODY_SUFFIX =
  " iOS non mi permette di chiederlo di nuovo — apri le Impostazioni per attivarlo.";

export type EnsurePermissionResult = {
  granted: boolean;
  /**
   * Path percorso, utile per logging/analytics:
   *   - "already_ok"          → era già granted, nessun prompt mostrato
   *   - "user_declined_prompt"→ utente ha toccato "Non ora" al pre-prompt
   *   - "system_granted"      → utente ha detto sì al dialog di sistema
   *   - "system_denied"       → utente ha detto no al dialog di sistema
   *   - "settings_declined"   → utente ha toccato "Non ora" al fallback settings
   *   - "settings_opened"     → utente ha aperto le Impostazioni (esito ignoto)
   *   - "error"               → eccezione durante il check/request
   */
  path:
    | "already_ok"
    | "user_declined_prompt"
    | "system_granted"
    | "system_denied"
    | "settings_declined"
    | "settings_opened"
    | "error";
};

/**
 * Assicura il permesso Speech Recognition (iOS: mic + speech recognition;
 * Android: RECORD_AUDIO). Chiamalo PRIMA di ogni operazione che richieda
 * la voce dell'utente.
 *
 * Ritorna una Promise che si risolve SOLO dopo che l'utente ha risposto
 * al pre-prompt e al dialog di sistema (o è arrivato al fallback settings).
 */
export async function ensureSpeechPermission(): Promise<EnsurePermissionResult> {
  // === Step 1: check stato attuale ==========================================
  let status: {
    granted?: boolean;
    canAskAgain?: boolean;
  };
  try {
    status = await ExpoSpeechRecognitionModule.getPermissionsAsync();
  } catch (e: any) {
    console.warn(`${TAG} getPermissions error: ${e?.message || e}`);
    return { granted: false, path: "error" };
  }

  if (status?.granted) {
    return { granted: true, path: "already_ok" };
  }

  const canAskAgain = status?.canAskAgain !== false; // default true se undefined

  // === Step 2: fork sui due flow ============================================
  if (canAskAgain) {
    // Undetermined o denied 1a volta → possiamo ancora chiedere via dialog sistema
    return new Promise<EnsurePermissionResult>((resolve) => {
      Alert.alert(
        PRE_PROMPT_TITLE,
        PRE_PROMPT_BODY,
        [
          {
            text: "Non ora",
            style: "cancel",
            onPress: () => {
              resolve({ granted: false, path: "user_declined_prompt" });
            },
          },
          {
            text: "OK",
            style: "default",
            onPress: async () => {
              try {
                const res =
                  await ExpoSpeechRecognitionModule.requestPermissionsAsync();
                resolve({
                  granted: !!res?.granted,
                  path: res?.granted ? "system_granted" : "system_denied",
                });
              } catch (e: any) {
                console.warn(`${TAG} requestPermissions error: ${e?.message || e}`);
                resolve({ granted: false, path: "error" });
              }
            },
          },
        ],
        { cancelable: false }
      );
    });
  }

  // === Step 3: denied definitivo, apre Impostazioni ========================
  return new Promise<EnsurePermissionResult>((resolve) => {
    Alert.alert(
      PRE_PROMPT_TITLE,
      PRE_PROMPT_BODY + SETTINGS_BODY_SUFFIX,
      [
        {
          text: "Non ora",
          style: "cancel",
          onPress: () => resolve({ granted: false, path: "settings_declined" }),
        },
        {
          text: "Apri Impostazioni",
          style: "default",
          onPress: async () => {
            try {
              await Linking.openSettings();
            } catch (e) {
              console.warn(`${TAG} openSettings failed:`, e);
            }
            resolve({ granted: false, path: "settings_opened" });
          },
        },
      ],
      { cancelable: false }
    );
  });
}

/**
 * Utility passiva: controlla stato SENZA mostrare alert.
 * Usato al mount per decidere se il pulsante voice è "già ok" o "va chiesto".
 */
export async function getSpeechPermissionStatus(): Promise<{
  granted: boolean;
  canAskAgain: boolean;
}> {
  try {
    const s = await ExpoSpeechRecognitionModule.getPermissionsAsync();
    return {
      granted: !!s?.granted,
      canAskAgain: s?.canAskAgain !== false,
    };
  } catch {
    return { granted: false, canAskAgain: true };
  }
}
