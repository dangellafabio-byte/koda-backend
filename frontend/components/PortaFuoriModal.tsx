/**
 * PortaFuoriModal — UI per il ponte one-shot dal Confessionale.
 *
 * Flusso (3 step):
 *   1. INTRO: spiega cosa sta per succedere ("apriamo la stanza segreta
 *      per UN solo turno, poi si chiude") + input parola segreta.
 *   2. PREVIEW: mostra gli entry decifrati in chiaro come anteprima, così
 *      l'utente VEDE cosa sta autorizzando a portare fuori. Bottone "Sì,
 *      apri il ponte" → chiama openBridge() e chiude il modal.
 *   3. BUSY: spinner mentre deriva la chiave + decritta.
 *
 * Sicurezza: la parola segreta NON viene mai inviata al server. Tutto
 * il KDF e la decrittazione avvengono in RAM nel device.
 */
import React, { useEffect, useState } from "react";
import {
  View,
  Text,
  Modal,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import {
  decryptConfessionalHistory,
  openBridge,
  type DecryptedEntry,
} from "../lib/bringOut";

type Props = {
  visible: boolean;
  onClose: () => void;
  /** Chiamato quando l'utente ha aperto il ponte. Il main UI sa che il
   *  prossimo turno passerà automaticamente bridged_secrets. */
  onBridgeOpened: () => void;
  theme: any;
};

type Step = "intro" | "busy" | "preview" | "error";

export default function PortaFuoriModal({
  visible,
  onClose,
  onBridgeOpened,
  theme,
}: Props) {
  const [step, setStep] = useState<Step>("intro");
  const [word, setWord] = useState("");
  const [decrypted, setDecrypted] = useState<DecryptedEntry[]>([]);
  const [err, setErr] = useState<string | null>(null);

  // Reset stato a ogni apertura — niente persistenza fra una sessione e
  // l'altra del modale.
  useEffect(() => {
    if (visible) {
      setStep("intro");
      setWord("");
      setDecrypted([]);
      setErr(null);
    } else {
      // Sovrascrivi la word con vuoto prima di chiudere — paranoia.
      setWord("");
      setDecrypted([]);
    }
  }, [visible]);

  const handleUnlock = async () => {
    const w = (word || "").trim();
    if (!w) {
      setErr("Inserisci la parola segreta.");
      return;
    }
    setErr(null);
    setStep("busy");
    try {
      const entries = await decryptConfessionalHistory(w);
      if (entries === null) {
        setErr("Parola segreta sbagliata. Riprova.");
        setStep("intro");
        return;
      }
      if (entries.length === 0) {
        setErr("La stanza segreta è ancora vuota.");
        setStep("intro");
        return;
      }
      setDecrypted(entries);
      setStep("preview");
    } catch (e: any) {
      console.warn("[PortaFuori] decrypt failed:", e);
      setErr("Errore durante l'apertura. Riprova.");
      setStep("intro");
    }
  };

  const handleConfirm = () => {
    openBridge(decrypted);
    // Cancella subito dal local state prima di chiudere
    setDecrypted([]);
    setWord("");
    onBridgeOpened();
    onClose();
  };

  const handleCancel = () => {
    setDecrypted([]);
    setWord("");
    onClose();
  };

  const accentColor = theme?.accent || "#A78BFA"; // violetto coerente col confessionale

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={handleCancel}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={styles.backdrop}
      >
        <View style={[styles.card, { backgroundColor: theme?.cardBg || "#0F1620" }]}>
          {/* Header con icona "chiave" — riconoscibile come bridge */}
          <View style={styles.header}>
            <View style={[styles.iconBadge, { backgroundColor: `${accentColor}22` }]}>
              <Ionicons name="key" size={26} color={accentColor} />
            </View>
            <Text style={[styles.title, { color: theme?.text || "#E5F7EE" }]}>
              Porta fuori
            </Text>
            <Text style={[styles.subtitle, { color: theme?.muted || "#8FA3B8" }]}>
              dalla stanza segreta
            </Text>
          </View>

          {step === "intro" && (
            <View>
              <Text style={[styles.bodyText, { color: theme?.text || "#E5F7EE" }]}>
                Sto per aprire la stanza segreta{" "}
                <Text style={{ fontWeight: "700", color: accentColor }}>
                  per un solo turno
                </Text>
                . Koda userà ciò che le hai confessato come contesto della tua prossima
                domanda. Subito dopo, la stanza si richiude e Koda lo dimentica.
              </Text>
              <Text style={[styles.hint, { color: theme?.muted || "#8FA3B8" }]}>
                La parola segreta non viene mai inviata. Tutto avviene sul tuo
                telefono.
              </Text>
              <TextInput
                value={word}
                onChangeText={setWord}
                placeholder="Parola segreta"
                placeholderTextColor="#6B7A8C"
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                style={[
                  styles.input,
                  {
                    color: theme?.text || "#E5F7EE",
                    borderColor: err ? "#EF4444" : `${accentColor}55`,
                  },
                ]}
                onSubmitEditing={handleUnlock}
                returnKeyType="go"
              />
              {err && <Text style={styles.errText}>{err}</Text>}
              <View style={styles.row}>
                <TouchableOpacity
                  style={[styles.btnGhost]}
                  onPress={handleCancel}
                  hitSlop={10}
                >
                  <Text style={styles.btnGhostText}>Annulla</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.btnPrimary, { backgroundColor: accentColor }]}
                  onPress={handleUnlock}
                  hitSlop={10}
                >
                  <Text style={styles.btnPrimaryText}>Apri</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}

          {step === "busy" && (
            <View style={styles.busyBox}>
              <ActivityIndicator size="large" color={accentColor} />
              <Text style={[styles.bodyText, { color: theme?.muted || "#8FA3B8", marginTop: 14 }]}>
                Sblocco in corso…
              </Text>
            </View>
          )}

          {step === "preview" && (
            <View>
              <Text style={[styles.bodyText, { color: theme?.text || "#E5F7EE" }]}>
                Stai per portare fuori{" "}
                <Text style={{ fontWeight: "700", color: accentColor }}>
                  {decrypted.length} memori{decrypted.length === 1 ? "a" : "e"}
                </Text>{" "}
                dalla stanza segreta. Koda le userà come contesto del tuo prossimo
                messaggio.
              </Text>
              <ScrollView
                style={styles.previewBox}
                contentContainerStyle={{ paddingVertical: 8 }}
                showsVerticalScrollIndicator
              >
                {decrypted.map((e, idx) => (
                  <View key={e.id} style={styles.previewItem}>
                    <Text style={[styles.previewRole, { color: accentColor }]}>
                      {e.role === "user" ? "Tu" : "Koda"} · {formatTs(e.ts)}
                    </Text>
                    <Text style={[styles.previewText, { color: theme?.text || "#E5F7EE" }]}>
                      {e.text}
                    </Text>
                    {idx < decrypted.length - 1 && <View style={styles.previewSep} />}
                  </View>
                ))}
              </ScrollView>
              <View style={styles.row}>
                <TouchableOpacity
                  style={[styles.btnGhost]}
                  onPress={handleCancel}
                  hitSlop={10}
                >
                  <Text style={styles.btnGhostText}>Annulla</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.btnPrimary, { backgroundColor: accentColor }]}
                  onPress={handleConfirm}
                  hitSlop={10}
                >
                  <Ionicons
                    name="arrow-forward"
                    size={16}
                    color="#0B0F14"
                    style={{ marginRight: 6 }}
                  />
                  <Text style={styles.btnPrimaryText}>Sì, portali fuori</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function formatTs(iso: string): string {
  try {
    const d = new Date(iso);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    if (sameDay) {
      return d.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });
    }
    return d.toLocaleDateString("it-IT", { day: "2-digit", month: "short" });
  } catch {
    return "";
  }
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.78)",
    justifyContent: "center",
    alignItems: "center",
    padding: 20,
  },
  card: {
    width: "100%",
    maxWidth: 440,
    borderRadius: 22,
    padding: 22,
    borderWidth: 1,
    borderColor: "rgba(167,139,250,0.18)",
  },
  header: {
    alignItems: "center",
    marginBottom: 18,
  },
  iconBadge: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 10,
  },
  title: {
    fontSize: 22,
    fontWeight: "700",
    letterSpacing: 0.2,
  },
  subtitle: {
    fontSize: 13,
    marginTop: 2,
  },
  bodyText: {
    fontSize: 15,
    lineHeight: 22,
    marginBottom: 10,
  },
  hint: {
    fontSize: 12,
    lineHeight: 17,
    fontStyle: "italic",
    marginTop: 4,
    marginBottom: 14,
  },
  input: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    marginBottom: 8,
    backgroundColor: "rgba(255,255,255,0.04)",
  },
  errText: {
    color: "#FCA5A5",
    fontSize: 13,
    marginBottom: 8,
  },
  row: {
    flexDirection: "row",
    justifyContent: "flex-end",
    alignItems: "center",
    gap: 10,
    marginTop: 12,
  },
  btnGhost: {
    paddingVertical: 11,
    paddingHorizontal: 16,
    borderRadius: 12,
    backgroundColor: "rgba(255,255,255,0.06)",
  },
  btnGhostText: {
    color: "#E5F7EE",
    fontSize: 15,
    fontWeight: "600",
  },
  btnPrimary: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 11,
    paddingHorizontal: 18,
    borderRadius: 12,
  },
  btnPrimaryText: {
    color: "#0B0F14",
    fontSize: 15,
    fontWeight: "700",
  },
  busyBox: {
    alignItems: "center",
    paddingVertical: 30,
  },
  previewBox: {
    maxHeight: 260,
    marginTop: 8,
    marginBottom: 6,
    borderRadius: 12,
    backgroundColor: "rgba(255,255,255,0.03)",
    paddingHorizontal: 12,
  },
  previewItem: {
    paddingVertical: 8,
  },
  previewRole: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.4,
    textTransform: "uppercase",
    marginBottom: 4,
  },
  previewText: {
    fontSize: 14,
    lineHeight: 20,
  },
  previewSep: {
    height: 1,
    backgroundColor: "rgba(255,255,255,0.07)",
    marginTop: 8,
  },
});
