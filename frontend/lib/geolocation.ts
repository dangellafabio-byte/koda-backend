/**
 * Geolocation helper per Koda — fix Fabio 2026-06-20
 * ──────────────────────────────────────────────────────────────────────
 * Obiettivo: dare a Koda il contesto della città dell'utente all'avvio
 * dell'app, in modo che possa rispondere a "che ore sono qui?", "che
 * tempo fa?", "che si fa stasera?" con la città giusta.
 *
 * Strategia: ONE-SHOT all'avvio (NO tracking continuo).
 *   1. Se l'utente ha abilitato il toggle nelle Impostazioni
 *   2. Chiediamo permission contestualmente al boot dell'app (con prompt
 *      pre-permission visibile come banner UI)
 *   3. getCurrentPositionAsync con accuratezza media (basta la città)
 *   4. reverseGeocodeAsync → estraiamo `city` o `region`
 *   5. POST /api/profile/location-context → backend salva come key_fact
 *
 * NIENTE BACKGROUND. Niente watchPositionAsync. Solo una posizione una
 * volta per sessione foreground.
 *
 * Permission flow segue le best practice di handle_permissions_contract:
 *  - Pre-permission prompt nel UI (toggle nelle Impostazioni stesso ha
 *    già una descrizione "Sapere la tua città per risposte contestuali")
 *  - Check permessi prima di richiedere
 *  - Gestione granted / denied / canAskAgain / blocked
 *  - Su blocked → mostriamo Linking.openSettings()
 *  - Su denied → degradazione gentile, NO crash, NO loop
 */

import * as Location from "expo-location";
import { Platform } from "react-native";

import { api } from "./api";

export type GeolocationResult =
  | { ok: true; city: string; region?: string; country?: string }
  | { ok: false; reason: "disabled" | "denied" | "blocked" | "no-network" | "error"; message?: string };

/**
 * Verifica i permessi GPS senza richiederli (silent check).
 * Utile per capire se vale la pena mostrare il toggle "abilitato" o
 * forzare l'utente in Impostazioni iOS/Android.
 */
export async function checkLocationPermission(): Promise<{
  granted: boolean;
  canAskAgain: boolean;
  status: Location.PermissionStatus;
}> {
  try {
    const res = await Location.getForegroundPermissionsAsync();
    return {
      granted: res.status === Location.PermissionStatus.GRANTED,
      canAskAgain: res.canAskAgain,
      status: res.status,
    };
  } catch (e) {
    console.warn("[geolocation] checkPermission error:", e);
    return {
      granted: false,
      canAskAgain: true,
      status: Location.PermissionStatus.UNDETERMINED,
    };
  }
}

/**
 * Recupera UNA volta la città dell'utente e la invia al backend.
 * Chiamata al boot dell'app SE settings.geolocation_enabled === true.
 *
 * Ritorna un GeolocationResult che il chiamante può loggare per
 * diagnostica ma non serve gestirlo: il backend è autosufficiente
 * (se la chiamata non arriva, Koda usa solo i fact dichiarati a voce).
 */
export async function fetchLocationOnce(opts?: {
  forceRequest?: boolean; // true = chiede permessi anche se mai concessi prima
}): Promise<GeolocationResult> {
  // Web: expo-location funziona in browser ma usiamo IP-based che è
  // poco preciso. Per ora skippiamo su web (TestFlight e Expo Go = mobile).
  if (Platform.OS === "web") {
    return { ok: false, reason: "disabled", message: "web platform" };
  }

  try {
    // 1. Check permessi attuali
    const existing = await Location.getForegroundPermissionsAsync();
    let status = existing.status;

    if (status !== Location.PermissionStatus.GRANTED) {
      if (!opts?.forceRequest && !existing.canAskAgain) {
        // Bloccato hard → utente deve aprire Impostazioni iOS/Android
        // manualmente. Non possiamo fare altro qui.
        return { ok: false, reason: "blocked", message: "permission permanently denied" };
      }
      // Richiedi permesso (sistema mostrerà il dialog nativo)
      const requested = await Location.requestForegroundPermissionsAsync();
      status = requested.status;
      if (status !== Location.PermissionStatus.GRANTED) {
        return {
          ok: false,
          reason: requested.canAskAgain ? "denied" : "blocked",
          message: "user denied permission",
        };
      }
    }

    // 2. Ottieni coordinate (accuracy.Balanced = bastano ~100m, città è ovvia)
    const pos = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.Balanced,
    });

    // 3. Reverse-geocode → nome città
    const places = await Location.reverseGeocodeAsync({
      latitude: pos.coords.latitude,
      longitude: pos.coords.longitude,
    });

    if (!places || places.length === 0) {
      return { ok: false, reason: "no-network", message: "reverse-geocode returned empty" };
    }

    const place = places[0];
    // Preferiamo `city`; fallback su `region` (es. "Lombardia"); poi `subregion`
    const city =
      (place.city && place.city.trim()) ||
      (place.subregion && place.subregion.trim()) ||
      (place.region && place.region.trim()) ||
      "";
    if (!city) {
      return { ok: false, reason: "no-network", message: "no city in reverse-geocode result" };
    }

    // 4. Invia al backend (salva come key_fact "In questo momento si trova a X")
    try {
      await api.postLocationContext({
        city,
        region: place.region || undefined,
        country: place.country || undefined,
      });
    } catch (e) {
      // Non blocco l'utente se la POST fallisce: il fact può anche essere
      // estratto a voce ("sono a Pavia"). Logghiamo e basta.
      console.warn("[geolocation] postLocationContext failed:", e);
    }

    console.log(`[KODA_GEO] location resolved: ${city} (${place.region || "?"}, ${place.country || "?"})`);
    return {
      ok: true,
      city,
      region: place.region || undefined,
      country: place.country || undefined,
    };
  } catch (e: any) {
    console.warn("[geolocation] fetchLocationOnce error:", e);
    return { ok: false, reason: "error", message: e?.message || String(e) };
  }
}
