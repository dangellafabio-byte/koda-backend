/**
 * VoiceOfOllenyaCard — Card nelle Impostazioni per selezionare provider
 * TTS (ElevenLabs / Inworld) e la voce (Cielo / Vento).
 * =====================================================================
 *
 * Specifiche Fabio 2026-10:
 *  1. Etichetta UI = "Voce di Ollenya" (non "Voce di Koda").
 *  2. Selettore provider con ElevenLabs come default provvisorio per
 *     nuovi utenti. Preferenza utente esistente conservata.
 *  3. Le voci NON disponibili per il provider selezionato appaiono
 *     DISABILITATE con breve spiegazione — NO selezione destinata a
 *     fallire.
 *  4. Non consuma API audio: il salvataggio aggiorna solo la preferenza
 *     DB via /api/tts/preferences. L'audio preview reale resta
 *     responsabilità di altri flussi (fuori scope di questa fase).
 *
 * Componente usato dentro il settingsCards wallet di index.tsx come
 * body di una nuova card (key="voice_provider").
 */
import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

import {
  fetchCatalog,
  fetchPrefs,
  updatePrefs,
  type TTSCatalog,
  type TTSPrefs,
  type TTSProvider,
  type VoiceEntry,
  DEFAULT_PROVIDER,
} from "../lib/ttsProviderClient";

type Props = {
  textColor: string;
  mutedColor: string;
  accentColor: string;
  cardBg: string;
  disabled?: boolean;
};

export default function VoiceOfOllenyaCard({
  textColor,
  mutedColor,
  accentColor,
  cardBg,
  disabled,
}: Props) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [catalog, setCatalog] = useState<TTSCatalog | null>(null);
  const [prefs, setPrefs] = useState<TTSPrefs | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const [cat, p] = await Promise.all([fetchCatalog(), fetchPrefs(true)]);
        if (cancelled) return;
        if (!cat) {
          setError("Catalogo voci non disponibile al momento.");
        } else {
          setCatalog(cat);
          // Se non c'è preferenza salvata (utente non autenticato o nuovo)
          // mostriamo lo stato default provvisorio senza salvarlo.
          setPrefs(
            p || {
              provider: cat.default_provider || DEFAULT_PROVIDER,
              voice_id: null,
              updated_at: null,
            }
          );
        }
      } catch (e) {
        void e;
        setError("Impossibile caricare le preferenze.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedProvider: TTSProvider = prefs?.provider || DEFAULT_PROVIDER;

  const voiceEntries: VoiceEntry[] = catalog?.voices || [];

  const resolveSelectedVoiceKey = (): string | null => {
    if (!catalog) return null;
    const vid = prefs?.voice_id;
    if (!vid) return null;
    // Match su chiave brand oppure su elevenlabs_voice_id salvato legacy.
    const byKey = voiceEntries.find((v) => v.key === vid);
    if (byKey) return byKey.key;
    const byEL = voiceEntries.find((v) => v.elevenlabs_voice_id === vid);
    if (byEL) return byEL.key;
    return null;
  };

  const selectedVoiceKey = resolveSelectedVoiceKey();

  const providerMeta = useMemo(() => {
    if (!catalog) return null;
    return catalog.providers_meta[selectedProvider] || null;
  }, [catalog, selectedProvider]);

  const applyPatch = async (patch: {
    provider?: TTSProvider;
    voice_id?: string;
  }) => {
    if (disabled) return;
    setSaving(true);
    setError(null);
    try {
      const next = await updatePrefs(patch);
      setPrefs(next);
    } catch (e: any) {
      const msg = String(e?.message || e || "Errore");
      // 401 → l'utente non è ancora autenticato: mostra alert gentile
      if (/401|autenticaz/i.test(msg)) {
        Alert.alert(
          "Accedi per salvare",
          "Per cambiare la Voce di Ollenya accedi al tuo account."
        );
      } else if (/409/.test(msg) || /non è disponibile/i.test(msg)) {
        Alert.alert("Voce non disponibile", msg);
      } else {
        setError(msg.slice(0, 200));
      }
    } finally {
      setSaving(false);
    }
  };

  const onPickProvider = async (p: TTSProvider) => {
    if (p === selectedProvider) return;
    // Se la voce corrente non è disponibile su `p`, dobbiamo sceglierne
    // una compatibile automaticamente (prima disponibile) altrimenti il
    // backend rifiuterebbe con 409. Non consentiamo mai una selezione
    // destinata a fallire.
    let patch: { provider: TTSProvider; voice_id?: string } = { provider: p };
    const curKey = selectedVoiceKey;
    const curEntry = curKey
      ? voiceEntries.find((v) => v.key === curKey)
      : null;
    const curCompatible = !!curEntry && curEntry.available_on.includes(p);
    if (!curCompatible) {
      const firstOnProvider = voiceEntries.find((v) =>
        v.available_on.includes(p)
      );
      if (!firstOnProvider) {
        Alert.alert(
          "Nessuna voce disponibile",
          `Nessuna voce di Ollenya è ancora disponibile su ${
            providerMeta?.name || p
          }.`
        );
        return;
      }
      patch.voice_id = firstOnProvider.key;
    }
    await applyPatch(patch);
  };

  const onPickVoice = async (voiceKey: string) => {
    const entry = voiceEntries.find((v) => v.key === voiceKey);
    if (!entry) return;
    if (!entry.available_on.includes(selectedProvider)) {
      Alert.alert(
        "Voce non disponibile",
        `La voce "${entry.name}" non è disponibile su ${
          providerMeta?.name || selectedProvider
        } in questa fase.`
      );
      return;
    }
    if (voiceKey === selectedVoiceKey) return;
    await applyPatch({ voice_id: voiceKey });
  };

  if (loading) {
    return (
      <View style={styles.loadingBox}>
        <ActivityIndicator color={accentColor} />
      </View>
    );
  }

  if (!catalog) {
    return (
      <View style={styles.loadingBox}>
        <Text style={{ color: mutedColor, fontSize: 13 }}>
          {error ||
            "Catalogo voci di Ollenya temporaneamente non disponibile. Riprova più tardi."}
        </Text>
      </View>
    );
  }

  return (
    <View style={{ marginTop: 8 }}>
      <Text style={[styles.sectionTitle, { color: textColor }]}>
        🎙️ Voce di Ollenya
      </Text>
      <Text style={[styles.hint, { color: mutedColor }]}>
        Scegli chi offre la voce di Ollenya e quale voce sentire.
      </Text>

      {/* Provider selector */}
      <Text style={[styles.subhead, { color: textColor }]}>Provider</Text>
      <View style={styles.row}>
        {(catalog.allowed_providers || []).map((p) => {
          const isActive = p === selectedProvider;
          const meta = catalog.providers_meta[p];
          return (
            <TouchableOpacity
              key={p}
              testID={`tts-provider-${p}`}
              onPress={() => onPickProvider(p)}
              disabled={saving || disabled}
              activeOpacity={0.75}
              style={[
                styles.pill,
                {
                  backgroundColor: isActive ? accentColor + "22" : cardBg,
                  borderColor: isActive ? accentColor : mutedColor + "55",
                  opacity: saving ? 0.6 : 1,
                },
              ]}
            >
              <Text
                style={[
                  styles.pillText,
                  { color: isActive ? accentColor : textColor },
                ]}
              >
                {meta?.name || p}
              </Text>
              {meta?.description ? (
                <Text style={[styles.pillSub, { color: mutedColor }]}>
                  {meta.description}
                </Text>
              ) : null}
              {p === "inworld" && meta?.model_locked === false ? (
                <Text style={[styles.pillSub, { color: mutedColor }]}>
                  Modello in valutazione
                </Text>
              ) : null}
            </TouchableOpacity>
          );
        })}
      </View>

      {/* Voice selector */}
      <Text style={[styles.subhead, { color: textColor, marginTop: 14 }]}>
        Voce
      </Text>
      <View style={styles.row}>
        {voiceEntries.map((v) => {
          const available = v.available_on.includes(selectedProvider);
          const isActive = v.key === selectedVoiceKey;
          return (
            <TouchableOpacity
              key={v.key}
              testID={`tts-voice-${v.key}`}
              onPress={() => onPickVoice(v.key)}
              disabled={!available || saving || disabled}
              activeOpacity={0.75}
              style={[
                styles.pill,
                {
                  backgroundColor:
                    isActive && available ? accentColor + "22" : cardBg,
                  borderColor:
                    isActive && available ? accentColor : mutedColor + "55",
                  opacity: available ? (saving ? 0.6 : 1) : 0.45,
                },
              ]}
            >
              <Text
                style={[
                  styles.pillText,
                  { color: isActive && available ? accentColor : textColor },
                ]}
              >
                {v.name}
              </Text>
              <Text style={[styles.pillSub, { color: mutedColor }]}>
                {v.gender === "femminile" ? "Femminile" : "Maschile"}
              </Text>
              {!available ? (
                <Text style={[styles.pillSub, { color: mutedColor }]}>
                  Non disponibile su{" "}
                  {catalog.providers_meta[selectedProvider]?.name ||
                    selectedProvider}
                </Text>
              ) : null}
            </TouchableOpacity>
          );
        })}
      </View>

      {error ? (
        <Text style={[styles.errorText, { color: "#EF4444" }]}>{error}</Text>
      ) : null}

      <Text style={[styles.footerNote, { color: mutedColor }]}>
        Il consumo dei 500 minuti/mese resta identico: viene contato
        l&apos;audio di Ollenya che senti davvero, indipendentemente dal
        provider.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  loadingBox: {
    minHeight: 80,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 12,
  },
  sectionTitle: {
    fontSize: 15,
    fontWeight: "700",
    marginBottom: 2,
  },
  subhead: {
    fontSize: 13,
    fontWeight: "600",
    marginTop: 10,
    marginBottom: 6,
    opacity: 0.9,
  },
  hint: {
    fontSize: 12.5,
    lineHeight: 17,
    marginBottom: 4,
  },
  row: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },
  pill: {
    minWidth: 140,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: 1,
  },
  pillText: {
    fontSize: 14,
    fontWeight: "600",
  },
  pillSub: {
    fontSize: 11.5,
    marginTop: 2,
    opacity: 0.85,
  },
  errorText: {
    marginTop: 10,
    fontSize: 12,
  },
  footerNote: {
    marginTop: 14,
    fontSize: 11.5,
    lineHeight: 16,
    opacity: 0.85,
  },
});
