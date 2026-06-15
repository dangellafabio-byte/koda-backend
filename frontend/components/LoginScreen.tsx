import React, { useState } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Platform,
  ActivityIndicator,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "../lib/auth";
import { api, persistToken } from "../lib/api";

export default function LoginScreen() {
  const { signInGoogle, signInApple, refresh } = useAuth() as any;
  const insets = useSafeAreaInsets();
  const [busy, setBusy] = useState<null | "google" | "apple" | "dev">(null);
  const [err, setErr] = useState<string | null>(null);

  const onGoogle = async () => {
    setErr(null);
    setBusy("google");
    try {
      await signInGoogle();
    } catch {
      setErr("Accesso Google non riuscito. Riprova.");
    } finally {
      setBusy(null);
    }
  };

  const onApple = async () => {
    setErr(null);
    setBusy("apple");
    try {
      await signInApple();
    } catch (e: any) {
      const msg = String(e?.message || "");
      if (!(msg.includes("canceled") || e?.code === "ERR_REQUEST_CANCELED")) {
        setErr("Accesso Apple non riuscito.");
      }
    } finally {
      setBusy(null);
    }
  };

  // DEV BYPASS: solo su web (preview Emergent), permette di entrare
  // senza OAuth (i cookie cross-domain del proxy preview rompono il
  // flusso Google). Da rimuovere prima del go-live in produzione web.
  const onDevLogin = async () => {
    setErr(null);
    setBusy("dev");
    try {
      const res: any = await (api as any).authDevLogin();
      if (res?.session_token) {
        await persistToken(res.session_token);
        if (typeof refresh === "function") await refresh();
      }
    } catch {
      setErr("Dev login non riuscito.");
    } finally {
      setBusy(null);
    }
  };

  const isIOS = Platform.OS === "ios";
  const isWeb = Platform.OS === "web";

  return (
    <View style={[styles.root, { paddingTop: insets.top + 40, paddingBottom: insets.bottom + 32 }]}>
      <View style={styles.center}>
        <View style={styles.orb} />
        <Text style={styles.brand}>Koda</Text>
        <Text style={styles.tagline}>Il tuo amico fraterno.{"\n"}Presente, non invadente.</Text>
      </View>

      <View style={styles.bottom}>
        {err ? <Text style={styles.err}>{err}</Text> : null}

        <TouchableOpacity
          style={[styles.btn, styles.googleBtn]}
          onPress={onGoogle}
          disabled={busy !== null}
          activeOpacity={0.85}
          testID="login-google"
        >
          {busy === "google" ? (
            <ActivityIndicator color="#1A1A1A" />
          ) : (
            <>
              <Ionicons name="logo-google" size={20} color="#1A1A1A" />
              <Text style={styles.googleText}>Continua con Google</Text>
            </>
          )}
        </TouchableOpacity>

        {isIOS ? (
          <TouchableOpacity
            style={[styles.btn, styles.appleBtn]}
            onPress={onApple}
            disabled={busy !== null}
            activeOpacity={0.85}
            testID="login-apple"
          >
            {busy === "apple" ? (
              <ActivityIndicator color="#FFF" />
            ) : (
              <>
                <Ionicons name="logo-apple" size={20} color="#FFF" />
                <Text style={styles.appleText}>Continua con Apple</Text>
              </>
            )}
          </TouchableOpacity>
        ) : (
          <View style={[styles.btn, styles.appleBtnDisabled]}>
            <Ionicons name="logo-apple" size={20} color="rgba(255,255,255,0.4)" />
            <Text style={styles.appleTextDisabled}>Accedi con Apple — disponibile nell'app</Text>
          </View>
        )}

        {isWeb ? (
          <TouchableOpacity
            style={[styles.btn, styles.devBtn]}
            onPress={onDevLogin}
            disabled={busy !== null}
            activeOpacity={0.85}
            testID="login-dev"
          >
            {busy === "dev" ? (
              <ActivityIndicator color="#FCD34D" />
            ) : (
              <>
                <Ionicons name="construct-outline" size={18} color="#FCD34D" />
                <Text style={styles.devText}>Entra come Tester (solo preview)</Text>
              </>
            )}
          </TouchableOpacity>
        ) : null}

        <Text style={styles.legal}>Accedendo accetti i Termini e la Privacy Policy di Koda.</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#08070A", paddingHorizontal: 28, justifyContent: "space-between" },
  center: { flex: 1, justifyContent: "center", alignItems: "center" },
  orb: { width: 96, height: 96, borderRadius: 48, backgroundColor: "#6EE7B7", marginBottom: 28, opacity: 0.9 },
  brand: { color: "#FFFFFF", fontSize: 40, fontWeight: "800", letterSpacing: 1 },
  tagline: { color: "rgba(255,255,255,0.6)", fontSize: 16, textAlign: "center", marginTop: 12, lineHeight: 24 },
  bottom: { gap: 12 },
  btn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10, height: 54, borderRadius: 14 },
  googleBtn: { backgroundColor: "#FFFFFF" },
  googleText: { color: "#1A1A1A", fontSize: 16, fontWeight: "700" },
  appleBtn: { backgroundColor: "#000000", borderWidth: 1, borderColor: "rgba(255,255,255,0.25)" },
  appleText: { color: "#FFFFFF", fontSize: 16, fontWeight: "700" },
  appleBtnDisabled: { backgroundColor: "rgba(255,255,255,0.05)", borderWidth: 1, borderColor: "rgba(255,255,255,0.1)" },
  appleTextDisabled: { color: "rgba(255,255,255,0.4)", fontSize: 14, fontWeight: "600" },
  devBtn: { backgroundColor: "rgba(252, 211, 77, 0.10)", borderWidth: 1, borderColor: "rgba(252, 211, 77, 0.45)", marginTop: 8 },
  devText: { color: "#FCD34D", fontSize: 14, fontWeight: "700" },
  err: { color: "#FCA5A5", fontSize: 14, textAlign: "center", marginBottom: 4 },
  legal: { color: "rgba(255,255,255,0.35)", fontSize: 12, textAlign: "center", marginTop: 8 },
});
