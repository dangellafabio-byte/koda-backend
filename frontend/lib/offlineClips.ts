/**
 * Offline Clips — "Sono qui, ma limitato"
 *
 * Modulo che gestisce le 3 clip audio pre-generate da ElevenLabs (server-side)
 * con la voce personalizzata di Koda. Le clip sono scaricate al boot (quando
 * online), cachate localmente in FileSystem.documentDirectory, e riprodotte
 * quando l'utente prova a parlare senza connessione.
 *
 * Obiettivo: NON spezzare l'illusione di presenza. Koda non scompare quando
 * cade la rete — risponde con la sua voce per dire "sono qui, ma offline".
 *
 * Architettura:
 *   1. preloadOfflineClips(voiceId) — chiamato al boot e quando l'utente
 *      cambia voce. Fa GET /api/offline-clips/manifest?voice_id=X, scarica
 *      i 3 mp3 e li salva in cacheDirectory/koda_offline_{voiceId}_{idx}.mp3.
 *   2. isOfflineNow() — check istantaneo via expo-network. true se senza rete.
 *   3. playRandomOfflineClip() — riproduce una clip random tra quelle
 *      scaricate. Ritorna true se ha trovato e iniziato a riprodurre, false
 *      se il pool è vuoto (es. primo avvio offline).
 *
 * Le clip sono inutili se l'utente non ha mai aperto l'app online almeno
 * una volta. In quel caso fallback silenzioso al banner di errore esistente.
 */
import { Platform } from "react-native";
import * as FileSystem from "expo-file-system/legacy";
import * as Network from "expo-network";
import { createAudioPlayer, setAudioModeAsync } from "expo-audio";
import { API_BASE, BACKEND } from "./api";

type OfflineClipEntry = {
  idx: number;
  text: string;
  localPath: string;  // file:// URI on native, blob URL on web
};

// Cache in-memory: voice_id → array di clip locali pronte
let _clipsByVoice: Map<string, OfflineClipEntry[]> = new Map();
let _lastPreloadVoice: string | null = null;
let _preloadInProgress = false;

const CLIP_DIR = (FileSystem as any).cacheDirectory
  ? `${(FileSystem as any).cacheDirectory}koda_offline/`
  : null;

/**
 * Scarica le 3 clip offline per la voce data, se non già presenti.
 * Idempotente: chiamabile a ogni avvio, no-op se già fatto.
 * Errori silenziati: in caso di fallimento (es. offline al primo avvio),
 * il pool resta vuoto e playRandomOfflineClip() ritornerà false.
 */
export async function preloadOfflineClips(voiceId: string): Promise<void> {
  if (!voiceId) return;
  if (_preloadInProgress) return;
  if (_lastPreloadVoice === voiceId && (_clipsByVoice.get(voiceId)?.length || 0) > 0) {
    return;  // già pronto per questa voce
  }
  _preloadInProgress = true;

  try {
    // Su web non scarichiamo file localmente — il browser cachea via HTTP.
    // Manteniamo gli URL diretti come "localPath" (verranno passati a Audio
    // come URL remoti). Funziona perché in offline il browser comunque
    // riusa il cache HTTP per gli stessi URL.
    if (Platform.OS === "web") {
      const resp = await fetch(`${API_BASE}/offline-clips/manifest?voice_id=${encodeURIComponent(voiceId)}`);
      if (!resp.ok) return;
      const data = await resp.json();
      const clips: OfflineClipEntry[] = (data.clips || []).map((c: any) => ({
        idx: c.idx,
        text: c.text || "",
        localPath: `${BACKEND}${c.url}`,
      }));
      if (clips.length > 0) {
        _clipsByVoice.set(voiceId, clips);
        _lastPreloadVoice = voiceId;
        // Triggero il preload HTTP-cache di ogni clip così sono disponibili
        // offline tramite Service Worker cache (se attivo) o browser cache.
        await Promise.all(clips.map((c) => fetch(c.localPath).catch(() => null)));
        console.log(`[OfflineClips] preloaded ${clips.length} clips (web) for voice ${voiceId}`);
      }
      return;
    }

    // Native (iOS/Android): scarico ogni clip in cacheDirectory.
    if (!CLIP_DIR) {
      console.warn("[OfflineClips] cacheDirectory unavailable");
      return;
    }

    // Assicura directory esistente
    try {
      const info = await (FileSystem as any).getInfoAsync(CLIP_DIR);
      if (!info.exists) {
        await (FileSystem as any).makeDirectoryAsync(CLIP_DIR, { intermediates: true });
      }
    } catch (e) {
      console.warn("[OfflineClips] makeDirectoryAsync failed:", e);
    }

    // Manifest
    const resp = await fetch(`${API_BASE}/offline-clips/manifest?voice_id=${encodeURIComponent(voiceId)}`);
    if (!resp.ok) {
      console.warn(`[OfflineClips] manifest HTTP ${resp.status}`);
      return;
    }
    const data = await resp.json();
    const manifestClips: { idx: number; text: string; url: string }[] = data.clips || [];

    const localClips: OfflineClipEntry[] = [];
    for (const c of manifestClips) {
      const localPath = `${CLIP_DIR}koda_offline_${voiceId}_${c.idx}.mp3`;
      try {
        // Se già esiste e ha dimensione > 0, skip download.
        const info = await (FileSystem as any).getInfoAsync(localPath);
        if (info.exists && info.size && info.size > 1000) {
          localClips.push({ idx: c.idx, text: c.text, localPath });
          continue;
        }
        // Download
        const remoteUrl = `${BACKEND}${c.url}`;
        const dl = await (FileSystem as any).downloadAsync(remoteUrl, localPath);
        if (dl && dl.status === 200) {
          localClips.push({ idx: c.idx, text: c.text, localPath });
        } else {
          console.warn(`[OfflineClips] download failed idx=${c.idx} status=${dl?.status}`);
        }
      } catch (e) {
        console.warn(`[OfflineClips] download error idx=${c.idx}:`, e);
      }
    }

    if (localClips.length > 0) {
      _clipsByVoice.set(voiceId, localClips);
      _lastPreloadVoice = voiceId;
      console.log(`[OfflineClips] preloaded ${localClips.length}/${manifestClips.length} clips for voice ${voiceId}`);
    }
  } catch (e) {
    console.warn("[OfflineClips] preload failed:", e);
  } finally {
    _preloadInProgress = false;
  }
}

/** Check immediato dello stato di rete. Usa expo-network. */
export async function isOfflineNow(): Promise<boolean> {
  try {
    if (Platform.OS === "web") {
      // navigator.onLine è la fonte ufficiale lato web.
      if (typeof navigator !== "undefined" && typeof navigator.onLine === "boolean") {
        return !navigator.onLine;
      }
      return false;
    }
    const st = await Network.getNetworkStateAsync();
    // st.isConnected = ha un'interfaccia attiva
    // st.isInternetReachable = è raggiungibile internet (più affidabile, ma a volte null)
    if (st?.isInternetReachable === false) return true;
    if (st?.isConnected === false) return true;
    return false;
  } catch (e) {
    console.warn("[OfflineClips] network check failed:", e);
    return false;
  }
}

/** Numero di clip attualmente disponibili per la voce data. */
export function offlineClipCount(voiceId: string): number {
  return _clipsByVoice.get(voiceId)?.length || 0;
}

/**
 * Riproduce una clip offline random per la voce data.
 *
 * @returns true se ha trovato una clip e iniziato il playback, false altrimenti.
 *   Il chiamante può usare il valore di ritorno per decidere il fallback
 *   (es. mostrare un banner "sei offline" se le clip non sono ancora cachate).
 */
export async function playRandomOfflineClip(voiceId: string): Promise<boolean> {
  const clips = _clipsByVoice.get(voiceId);
  if (!clips || clips.length === 0) {
    console.log(`[OfflineClips] no clips cached for voice ${voiceId}`);
    return false;
  }
  const pick = clips[Math.floor(Math.random() * clips.length)];
  console.log(`[OfflineClips] playing idx=${pick.idx} text="${pick.text.slice(0, 60)}"`);

  try {
    // Riusiamo la pipeline expo-audio (la stessa di speech.ts) ma in modo
    // semplificato: niente stallWatcher, niente onAudioStart elaborato.
    // Una clip offline è breve (~5s) e self-contained.
    if (Platform.OS !== "web") {
      try {
        await setAudioModeAsync({
          allowsRecording: false,
          playsInSilentMode: true,
          interruptionMode: "duckOthers",
          shouldPlayInBackground: false,
          shouldRouteThroughEarpiece: false,
        });
      } catch {}
    }

    return await new Promise<boolean>((resolve) => {
      let done = false;
      const finish = (ok: boolean) => {
        if (done) return;
        done = true;
        try { sub?.remove?.(); } catch {}
        try { player?.remove?.(); } catch {}
        resolve(ok);
      };
      let player: any = null;
      let sub: any = null;
      try {
        player = createAudioPlayer(pick.localPath, { updateInterval: 250 });
        sub = player.addListener("playbackStatusUpdate", (status: any) => {
          if (status?.isLoaded && status.didJustFinish) {
            finish(true);
          }
        });
        player.play();
        // Safety: anche se l'evento didJustFinish manca, chiudi dopo 8s.
        setTimeout(() => finish(true), 8000);
      } catch (e) {
        console.warn("[OfflineClips] play error:", e);
        finish(false);
      }
    });
  } catch (e) {
    console.warn("[OfflineClips] play exception:", e);
    return false;
  }
}
