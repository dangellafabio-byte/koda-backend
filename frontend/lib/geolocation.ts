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

// =============================================================
// CACHED LOCATION — singleton in-memory (Fabio 2026-06-29)
// =============================================================
// Conserva l'ultima posizione recuperata con successo da
// fetchLocationOnce / refreshLocationSilent. Letto direttamente dal
// flusso vocale (`voiceStreamConverse`) per iniettare la città nel
// payload WebSocket di OGNI turno → Koda sa sempre dove sei senza
// passare per database / multi-tenancy. Approccio "usa quello che hai".
// =============================================================
export type CachedLocation = {
  city: string;
  region?: string;
  country?: string;
  fetchedAt: number; // epoch ms
};

let _cachedLocation: CachedLocation | null = null;

/** Restituisce l'ultima posizione conosciuta o null se mai recuperata. */
export function getCachedLocation(): CachedLocation | null {
  return _cachedLocation;
}

/** Resetta la cache (es. quando l'utente disabilita il toggle). */
export function clearCachedLocation(): void {
  _cachedLocation = null;
}

function _setCachedLocation(r: { city: string; region?: string; country?: string }) {
  _cachedLocation = {
    city: r.city,
    region: r.region,
    country: r.country,
    fetchedAt: Date.now(),
  };
  console.log(
    `[KODA_GEO] cache updated → ${r.city} (${r.region || "?"}, ${r.country || "?"})`
  );
}

/**
 * Aggiornamento silenzioso della cache. Non chiede mai permessi:
 * se il permesso non c'è già, esce con `false`. Pensato per essere
 * chiamato PRIMA di ogni sessione vocale per avere la città fresca.
 * Massimo ~1s di latenza (Balanced accuracy).
 */
export async function refreshLocationSilent(): Promise<boolean> {
  if (Platform.OS === "web") return false;
  try {
    const existing = await Location.getForegroundPermissionsAsync();
    if (existing.status !== Location.PermissionStatus.GRANTED) {
      return false;
    }

    // === FIX 2026-07-24 v63.7 — PARITÀ iOS/Android (root cause) ===
    //
    // PROBLEMA OSSERVATO (log Xiaomi 24/07 20:45):
    //   getCurrentPositionAsync bloccava 26 secondi su MIUI/HyperOS.
    //   Su iOS la stessa chiamata risponde in ~200-800ms.
    //
    // CAUSA:
    //   • iOS: Core Location ha una cache OS condivisa. Qualsiasi altra
    //     app o servizio che ha usato la geolocalizzazione di recente
    //     popola la cache. CLLocationManager.requestLocation() la legge
    //     PRIMA di chiedere un fix fresco → risposta quasi istantanea.
    //   • Android/MIUI: FusedLocationProviderClient.getCurrentLocation()
    //     chiede SEMPRE un fix fresco (PRIORITY_BALANCED_POWER_ACCURACY).
    //     Non consulta mai la cache OS di sua iniziativa. Su MIUI, con
    //     GPS in cold-start, aspetta il primo fix hardware — che indoor
    //     può non arrivare mai.
    //
    // FIX (identico comportamento iOS/Android):
    //   1. PRIMA proviamo `getLastKnownPositionAsync` (cache OS, ~0ms
    //      su entrambe le piattaforme). È esattamente quello che iOS
    //      fa trasparentemente dentro `getCurrentPositionAsync`.
    //   2. SOLO SE la cache è vuota o troppo vecchia (> 5 min), chiediamo
    //      un fix live con `getCurrentPositionAsync`, cappato a 3 secondi
    //      per non bloccare la UI (matching il timeout implicito di iOS
    //      quando la cache è vuota e non c'è WiFi/cell nelle vicinanze).
    //
    // NB: GPS RESTA parte del flusso su ENTRAMBE le piattaforme (Fabio
    // ha chiesto parità iOS/Android, non feature-cutting). Cambia solo
    // l'ORDINE delle chiamate per rispecchiare la strategia cache-first
    // che iOS ha implicita a livello OS.

    let pos: Location.LocationObject | null = null;

    // 1) Cache OS (istantaneo — matches iOS internal behavior)
    try {
      const cacheT0 = Date.now();
      pos = await Location.getLastKnownPositionAsync({
        maxAge: 5 * 60 * 1000, // fino a 5 minuti
      });
      const cacheMs = Date.now() - cacheT0;
      if (pos) {
        console.log(
          `[KODA_GEO] cache hit lastKnown (${cacheMs}ms, age=${
            pos.timestamp ? Math.round((Date.now() - pos.timestamp) / 1000) : "?"
          }s)`
        );
      }
    } catch (e: any) {
      console.log(`[KODA_GEO] lastKnown error (non-fatal): ${e?.message || e}`);
      pos = null;
    }

    // 2) Cache miss → fix live con timeout 3s (parità iOS: quando la
    //    cache iOS è vuota, il sistema chiede WiFi+cell in ~1-3s e poi
    //    fallisce silenziosamente se il segnale non basta).
    if (!pos) {
      const liveT0 = Date.now();
      try {
        pos = await Promise.race<Location.LocationObject | null>([
          Location.getCurrentPositionAsync({
            accuracy: Location.Accuracy.Balanced,
          }),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
        ]);
        const liveMs = Date.now() - liveT0;
        if (pos) {
          console.log(`[KODA_GEO] live fix ok (${liveMs}ms)`);
        } else {
          console.log(`[KODA_GEO] live fix timeout after ${liveMs}ms — no location this turn`);
        }
      } catch (e: any) {
        console.log(`[KODA_GEO] live fix error: ${e?.message || e}`);
        pos = null;
      }
    }

    if (!pos) return false;

    // Reverse geocode con timeout 800ms (identico iOS/Android, dipende
    // dal servizio di reverse-geocoding del sistema, di solito veloce
    // ma capping per safety).
    const places = await Promise.race<Location.LocationGeocodedAddress[] | null>([
      Location.reverseGeocodeAsync({
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
      }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 800)),
    ]);
    if (!places || places.length === 0) return false;
    const p = places[0];
    const city =
      (p.city && p.city.trim()) ||
      (p.subregion && p.subregion.trim()) ||
      (p.region && p.region.trim()) ||
      "";
    if (!city) return false;
    _setCachedLocation({
      city,
      region: p.region || undefined,
      country: p.country || undefined,
    });
    return true;
  } catch (e: any) {
    console.log(`[KODA_GEO] refreshLocationSilent error: ${e?.message || String(e)}`);
    return false;
  }
}

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
  } catch (e: any) {
    console.log(`[KODA_GEO] checkPermission error: ${e?.message || String(e)}`);
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
    // === FIX 2026-06-29 Geo diagnostics ===
    // Prima la POST era avvolta in try/catch che usava console.warn → il
    // warning NON viene catturato dal diagnostic logger (filtra solo
    // console.log) → bug invisibile. Adesso loggamo TUTTI gli step con
    // console.log così sono visibili nel diag e capiamo dove si rompe.
    console.log(
      `[KODA_GEO] POST /api/profile/location-context starting → city=${city} region=${place.region || "?"}`
    );
    let postOk = false;
    let postError: string | null = null;
    // Retry: fino a 3 tentativi con backoff 0/1.5s/3s, per superare
    // network blip momentanei o cold-start del backend.
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const resp = await api.postLocationContext({
          city,
          region: place.region || undefined,
          country: place.country || undefined,
        });
        postOk = !!resp?.ok;
        console.log(
          `[KODA_GEO] POST /api/profile/location-context OK (attempt ${attempt}) → ok=${resp?.ok} fact="${resp?.fact || "?"}"`
        );
        postError = null;
        break; // successo → esci dal retry loop
      } catch (e: any) {
        postError = e?.message || String(e);
        console.log(
          `[KODA_GEO] POST /api/profile/location-context FAILED (attempt ${attempt}/3) → ${postError}`
        );
        if (attempt < 3) {
          await new Promise((r) => setTimeout(r, attempt * 1500));
        }
      }
    }

    console.log(
      `[KODA_GEO] location resolved: ${city} (${place.region || "?"}, ${place.country || "?"}) postOk=${postOk}`
    );
    // === FIX 2026-06-29 — popola la cache in-memory letta dal flusso vocale ===
    _setCachedLocation({
      city,
      region: place.region || undefined,
      country: place.country || undefined,
    });
    return {
      ok: true,
      city,
      region: place.region || undefined,
      country: place.country || undefined,
      // Embedded diagnostics nel result così il chiamante può loggarlo:
      ...(postError ? { postError } : {}),
    } as GeolocationResult & { postError?: string };
  } catch (e: any) {
    console.log(`[KODA_GEO] fetchLocationOnce ERROR (outer): ${e?.message || String(e)}`);
    return { ok: false, reason: "error", message: e?.message || String(e) };
  }
}
