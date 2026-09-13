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
 *  ciclamino, speaking viola). */
export const ALT_IDLE_COLOR = "#7DD3FC";

/** Default assoluto: nessuna calibrazione, il componente usa la sua
 *  euristica. */
export const DEFAULT_CALIBRATION: BorderCalibration = {
  radius: null,
  thickness: null,
  useAltIdleColor: false,
};


/**
 * Stima il corner radius fisico dello schermo del device basandosi sul
 * safe-area inset TOP (che React Native espone sempre) + Platform.OS.
 *
 * PERCHÉ QUI (2026-06 Fabio):
 * iOS e Android NON espongono API pubbliche per leggere il vero corner
 * radius del display. `expo-device` e `react-native-device-info` non lo
 * forniscono. L'unico modo affidabile senza mapping hardcoded per ogni
 * modello (fragile: nuovi device escono ogni anno) è **stimare** dal
 * safe-area top inset, che correla fortemente col design del device:
 *
 *   iOS Dynamic Island (iPhone 14 Pro+):  top ≥ 54  → radius ~55
 *   iOS Notch classico   (iPhone X-13):   top ≥ 44  → radius ~47
 *   Android con notch/hole:                top ≥ 24  → radius ~32
 *   Rettangolare (iPhone SE, Android old): top < 24  → radius 0
 *
 * Non è PERFETTO (OnePlus/Xiaomi con schermi curvi 4-lati possono avere
 * radius reali diversi), ma copre ~90% dei device correttamente.
 * L'utente può SEMPRE override manualmente dallo slider in Impostazioni.
 */
export function estimateCornerRadius(topInset: number, platformOS: string): number {
  if (platformOS === "ios") {
    if (topInset >= 54) return 55; // Dynamic Island
    if (topInset >= 44) return 47; // Notch classico
    return 0; // iPhone SE / iPad rettangolari
  }
  // Android — più eterogeneo, valori medi euristici
  if (topInset >= 24) return 32;
  return 8;
}

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
