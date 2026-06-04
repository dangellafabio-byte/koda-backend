import React, { useState, useEffect } from "react";
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
  Alert,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import {
  setSecretWord,
  clearSecretWord,
  biometricAvailable,
  getSessionKey,
  forgetSessionKey,
} from "../lib/sealedCrypto";

type Props = {
  visible: boolean;
  hasSeal: boolean;
  confessionalActive: boolean;
  onClose: () => void;
  onSaved: () => void;
  onCleared: () => void;
  styles: any;
  theme: any;
};

export default function SealSetupModal({
  visible,
  hasSeal,
  onClose,
  onSaved,
  onCleared,
  theme,
}: Props) {
  const [word, setWord] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [bioOk, setBioOk] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) {
      setWord("");
      setConfirm("");
      setErr(null);
      setBusy(false);
    } else {
      biometricAvailable().then(setBioOk);
    }
  }, [visible]);

  const onSave = async () => {
    setErr(null);
    if (word.length < 4) {
      setErr("Almeno 4 caratteri.");
      return;
    }
    if (word !== confirm) {
      setErr("Le due parole non coincidono.");
      return;
    }
    setBusy(true);
    try {
      // Salviamo la Parola Segreta. Se possibile usiamo bio per sblocco futuro.
      await setSecretWord(word, { biometric: bioOk });
      // Forziamo derivazione + cache della session key (preriscaldamento).
      forgetSessionKey();
      // NB: getSessionKey scatena lo sblocco biometrico se attivo. Non lo
      // chiamiamo qui per non far apparire il prompt subito dopo il setup;
      // sarà chiamato al primo invio confessionale.
      onSaved();
    } catch (e: any) {
      setErr(e?.message || "Errore nel salvare la parola.");
    } finally {
      setBusy(false);
    }
  };

  const onClear = async () => {
    Alert.alert(
      "Cancellare la Parola Segreta?",
      "Tutti i futuri messaggi confessionali viaggeranno SOLO in modalità effimera (non salvati su DB ma il backend li vede in chiaro durante la chiamata a Claude).",
      [
        { text: "Annulla", style: "cancel" },
        {
          text: "Cancella",
          style: "destructive",
          onPress: async () => {
            setBusy(true);
            try {
              await clearSecretWord();
              forgetSessionKey();
              onCleared();
            } finally {
              setBusy(false);
            }
          },
        },
      ]
    );
  };

  const s = makeStyles(theme);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={s.overlay}
      >
        <View style={s.card}>
          <View style={s.header}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Ionicons
                name={hasSeal ? "lock-closed" : "key-outline"}
                size={22}
                color={hasSeal ? "#34D399" : theme.primary}
              />
              <Text style={s.title}>
                {hasSeal ? "Parola Segreta" : "Crea Confessionale"}
              </Text>
            </View>
            <TouchableOpacity onPress={onClose} hitSlop={10}>
              <Ionicons name="close" size={24} color={theme.text} />
            </TouchableOpacity>
          </View>

          {!hasSeal ? (
            <>
              <Text style={s.body}>
                La <Text style={s.bold}>Parola Segreta</Text> cifra le tue
                confessioni{" "}
                <Text style={s.bold}>direttamente sul tuo telefono</Text>. Ogni
                messaggio viaggia cifrato, e neanche i nostri server vedono
                qualcosa in chiaro nei log.
              </Text>
              <Text style={s.bodySmall}>
                ⚠️ Se la dimentichi non potremo recuperarla. Le confessioni non
                sono salvate (vivono solo in RAM) quindi non c'è bisogno di
                ricordarla per "leggerle dopo" — serve solo per cifrare il
                trasporto.
              </Text>
              <TextInput
                style={s.input}
                placeholder="Parola Segreta (min. 4 caratteri)"
                placeholderTextColor={theme.text + "80"}
                value={word}
                onChangeText={setWord}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                testID="seal-input-word"
              />
              <TextInput
                style={s.input}
                placeholder="Ripetila"
                placeholderTextColor={theme.text + "80"}
                value={confirm}
                onChangeText={setConfirm}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                testID="seal-input-confirm"
              />
              {bioOk ? (
                <Text style={s.bioHint}>
                  🔓 Il tuo dispositivo verrà sbloccato con FaceID / TouchID per
                  ogni nuova confessione.
                </Text>
              ) : (
                <Text style={s.bioHint}>
                  💡 Il dispositivo non ha biometria attiva: la chiave sarà
                  protetta dal blocco schermo.
                </Text>
              )}
              {err ? <Text style={s.err}>{err}</Text> : null}
              <TouchableOpacity
                style={[s.primaryBtn, busy && { opacity: 0.6 }]}
                disabled={busy}
                onPress={onSave}
                testID="seal-save"
              >
                {busy ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={s.primaryBtnText}>Conferma</Text>
                )}
              </TouchableOpacity>
            </>
          ) : (
            <>
              <Text style={s.body}>
                La tua Parola Segreta è{" "}
                <Text style={s.bold}>già impostata</Text>. Le confessioni
                vengono cifrate localmente prima di essere inviate.
              </Text>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 4 }}>
                <Ionicons name="shield-checkmark" size={18} color="#34D399" />
                <Text style={[s.bodySmall, { color: "#34D399", marginTop: 0 }]}>
                  Cifratura attiva — XSalsa20-Poly1305
                </Text>
              </View>
              <View style={{ height: 16 }} />
              <TouchableOpacity
                style={[s.dangerBtn, busy && { opacity: 0.6 }]}
                disabled={busy}
                onPress={onClear}
                testID="seal-clear"
              >
                {busy ? (
                  <ActivityIndicator color="#FCA5A5" />
                ) : (
                  <Text style={s.dangerBtnText}>Cancella la Parola</Text>
                )}
              </TouchableOpacity>
              <TouchableOpacity
                style={s.secondaryBtn}
                onPress={onClose}
                testID="seal-keep"
              >
                <Text style={s.secondaryBtnText}>Tieni così</Text>
              </TouchableOpacity>
            </>
          )}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function makeStyles(theme: any) {
  return StyleSheet.create({
    overlay: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.65)",
      justifyContent: "center",
      alignItems: "center",
      padding: 24,
    },
    card: {
      width: "100%",
      maxWidth: 420,
      // === FIX 2026-06 #5: usare theme.surface, NON theme.card (che non
      // esiste nella Palette type → fallback fisso a #1E1B2E creava un
      // box scuro anche in tema Giorno, rendendo invisibile il testo). ===
      backgroundColor: theme.surface,
      borderRadius: 18,
      padding: 22,
      gap: 14,
      borderWidth: 1,
      borderColor: theme.border,
    },
    header: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
    },
    title: {
      fontSize: 20,
      fontWeight: "700",
      color: theme.text,
    },
    body: {
      fontSize: 15,
      color: theme.text,
      lineHeight: 22,
    },
    bodySmall: {
      fontSize: 13,
      color: theme.textMuted,
      lineHeight: 19,
      marginTop: 4,
    },
    bold: {
      fontWeight: "700",
      color: theme.primary,
    },
    input: {
      borderWidth: 1,
      borderColor: theme.border,
      borderRadius: 12,
      paddingHorizontal: 14,
      paddingVertical: 12,
      fontSize: 16,
      color: theme.text,
      backgroundColor: theme.surfaceAlt,
    },
    bioHint: {
      fontSize: 12,
      color: theme.textDim,
      fontStyle: "italic",
    },
    err: {
      color: "#FCA5A5",
      fontSize: 13,
      textAlign: "center",
    },
    primaryBtn: {
      backgroundColor: theme.primary || "#A78BFA",
      paddingVertical: 14,
      borderRadius: 12,
      alignItems: "center",
      marginTop: 6,
    },
    primaryBtnText: {
      color: "#fff",
      fontSize: 16,
      fontWeight: "700",
    },
    dangerBtn: {
      borderWidth: 1,
      borderColor: "rgba(252,165,165,0.4)",
      paddingVertical: 14,
      borderRadius: 12,
      alignItems: "center",
    },
    dangerBtnText: {
      color: "#FCA5A5",
      fontSize: 15,
      fontWeight: "600",
    },
    secondaryBtn: {
      paddingVertical: 12,
      alignItems: "center",
    },
    secondaryBtnText: {
      color: (theme.text || "#fff") + "B0",
      fontSize: 14,
    },
  });
}
