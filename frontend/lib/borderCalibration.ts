/**
 * borderCalibration.ts — Persistenza calibrazione utente del NeonBorder.
 *
 * PERCHÉ ESISTE (2026-08-02, Fabio dopo bug Honor):
 * Il NeonBorder ha un default euristico (radius 48 Android, thickness 4)
 * che va bene sulla maggioranza dei device, ma su alcuni schermi Android
 * con curvatura particolarmente pronunciata (Honor Magic V/MagicOS, alcuni
 * Xiaomi con schermi 4-lati curvi) la curva fisica del vetro "mangia" il
 * bordo software, rendendolo poco visibile agli angoli.
 *
 * Soluzione: permettere all'utente di calibrare manualmente radius +
 * thickness + colore idle alternativo dalla schermata Impostazioni. La
 * calibrazione è persistente per device (SecureStore locale, non nel
 * profilo cloud) perché è una preferenza legata alla fisica dello
 * schermo, non all'identità utente.
 */
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

const KEY = "koda_border_calibration_v1";

export type BorderCalibration = {
  /** Corner radius del bordo in px. Range consigliato: 0-70.
   *  null = usa euristica default del componente NeonBorder. */
  radius: number | null;
  /** Spessore del bordo in px. Range consigliato: 2-6.
   *  null = usa default per piattaforma (4 Android, 3 iOS). */
  thickness: number | null;
  /** Se true, usa il colore idle "alternativo" (più visibile) invece
   *  del champagne default. Utile su schermi curvi dove il champagne
   *  si mimetizza. Il colore alternativo è pastel-cyan (#7DD3FC),
   *  scelto per contrasto massimo senza confondersi con recording (#00F5D4). */
  useAltIdleColor: boolean;
};

/** Colore idle alternativo quando l'utente lo attiva.
 *  Pastel-cyan chiaro: si vede benissimo su qualunque wallpaper, non
 *  confondibile con nessuno degli altri stati (recording tiffany, thinking
 *  ciclamino, speaking viola, confessional scarlatto). */
export const ALT_IDLE_COLOR = "#7DD3FC";

/** Default assoluto: nessuna calibrazione, il componente usa la sua
 *  euristica. */
export const DEFAULT_CALIBRATION: BorderCalibration = {
  radius: null,
  thickness: null,
  useAltIdleColor: false,
};

/** Legge la calibrazione salvata. Se non esiste o è corrotta, ritorna default. */
export async function loadBorderCalibration(): Promise<BorderCalibration> {
  try {
    // Su web SecureStore non è disponibile: skip (usa default euristico).
    if (Platform.OS === "web") return DEFAULT_CALIBRATION;
    const raw = await SecureStore.getItemAsync(KEY);
    if (!raw) return DEFAULT_CALIBRATION;
    const parsed = JSON.parse(raw);
    // Validazione difensiva: se qualcuno ha smanettato con lo storage,
    // ricadiamo su default piuttosto che passare valori assurdi al componente.
    const radius =
      typeof parsed.radius === "number" && parsed.radius >= 0 && parsed.radius <= 100
        ? parsed.radius
        : null;
    const thickness =
      typeof parsed.thickness === "number" && parsed.thickness >= 1 && parsed.thickness <= 10
        ? parsed.thickness
        : null;
    const useAltIdleColor = parsed.useAltIdleColor === true;
    return { radius, thickness, useAltIdleColor };
  } catch {
    return DEFAULT_CALIBRATION;
  }
}

/** Salva la calibrazione. Idempotente. */
export async function saveBorderCalibration(cal: BorderCalibration): Promise<void> {
  try {
    if (Platform.OS === "web") return; // no-op su web
    await SecureStore.setItemAsync(KEY, JSON.stringify(cal));
  } catch (e) {
    console.warn("[borderCalibration] save failed:", e);
  }
}

/** Reset alla calibrazione default (rimuove il record). */
export async function resetBorderCalibration(): Promise<void> {
  try {
    if (Platform.OS === "web") return;
    await SecureStore.deleteItemAsync(KEY);
  } catch {}
}
