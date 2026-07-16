import React, { createContext, useContext, useEffect, useState, useCallback } from "react";
import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";
import * as WebBrowser from "expo-web-browser";
import * as Linking from "expo-linking";
import { api } from "./api";
import { setAuthTokenMem } from "./authToken";

const TOKEN_KEY = "koda_session_token";
const EMERGENT_AUTH_URL = "https://auth.emergentagent.com/";

async function persistToken(tok: string | null) {
  setAuthTokenMem(tok);
  try {
    if (Platform.OS === "web") {
      if (typeof localStorage !== "undefined") {
        if (tok) localStorage.setItem(TOKEN_KEY, tok);
        else localStorage.removeItem(TOKEN_KEY);
      }
    } else {
      if (tok) await SecureStore.setItemAsync(TOKEN_KEY, tok);
      else await SecureStore.deleteItemAsync(TOKEN_KEY);
    }
  } catch {}
}

async function readToken(): Promise<string | null> {
  try {
    if (Platform.OS === "web") {
      return typeof localStorage !== "undefined" ? localStorage.getItem(TOKEN_KEY) : null;
    }
    return await SecureStore.getItemAsync(TOKEN_KEY);
  } catch {
    return null;
  }
}

type User = { email: string; provider?: string } | null;
type AuthState = {
  user: User;
  loading: boolean;
  signInGoogle: () => Promise<void>;
  signInApple: () => Promise<void>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
};

const AuthCtx = createContext<AuthState>({
  user: null,
  loading: true,
  signInGoogle: async () => {},
  signInApple: async () => {},
  signOut: async () => {},
  refresh: async () => {},
});

export const useAuth = () => useContext(AuthCtx);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const tok = await readToken();
    setAuthTokenMem(tok);
    if (!tok) {
      setUser(null);
      return;
    }
    try {
      const me = await api.authMe();
      setUser(me);
    } catch (e: any) {
      // === FIX 2026-07-16 (utente "sono entrato una volta, ora non più") ===
      // BUG PRECEDENTE: qualsiasi errore da /auth/me → persistToken(null).
      // Anche un timeout di rete o un 502 transitorio cancellava il token
      // dell'utente → costretto a ri-loggarsi. Ora cancelliamo il token
      // SOLO se la risposta è esplicitamente 401 (auth invalido). Per
      // qualsiasi altro errore (network flake, 5xx, timeout) manteniamo
      // il token e riproviamo al prossimo boot.
      const msg = String(e?.message || "");
      const is401 = msg.includes("HTTP 401") || msg.includes("401:");
      if (is401) {
        console.log("[KODA_AUTH] authMe → 401, wiping token");
        await persistToken(null);
        setUser(null);
      } else {
        console.log(`[KODA_AUTH] authMe transient error (token preserved): ${msg}`);
        // NON wipare il token. Non settiamo user finché non riusciamo a
        // validarlo, ma al prossimo refresh (o boot) proveremo di nuovo.
        setUser(null);
      }
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        // Web: dopo l'OAuth Google, Emergent ci rimanda con #session_id=...
        if (
          Platform.OS === "web" &&
          typeof window !== "undefined" &&
          window.location.hash &&
          window.location.hash.includes("session_id=")
        ) {
          const sid = new URLSearchParams(window.location.hash.replace(/^#/, "")).get("session_id");
          if (sid) {
            try {
              const res = await api.authGoogleSession(sid);
              await persistToken(res.session_token);
              window.history.replaceState(null, "", window.location.pathname + window.location.search);
            } catch {}
          }
        }
      } catch {}
      await refresh();
      setLoading(false);
    })();
  }, [refresh]);

  const signInGoogle = useCallback(async () => {
    if (Platform.OS === "web") {
      if (typeof window !== "undefined") {
        const redirect = window.location.origin + window.location.pathname;
        window.location.href = `${EMERGENT_AUTH_URL}?redirect=${encodeURIComponent(redirect)}`;
      }
      return;
    }
    const redirect = Linking.createURL("/");
    const authUrl = `${EMERGENT_AUTH_URL}?redirect=${encodeURIComponent(redirect)}`;
    // === DIAG 2026-07-16 (utente: "sono entrato una volta, ora non più") ===
    // Log dettagliato di ogni step Google — così sul prossimo build vediamo
    // in log dispositivo dov'è la rottura.
    try {
      console.log(`[KODA_AUTH_G] start redirect=${redirect}`);
      const result = await WebBrowser.openAuthSessionAsync(authUrl, redirect);
      console.log(`[KODA_AUTH_G] result.type=${result.type} url=${(result as any).url || "-"}`);
      if (result.type === "success" && result.url) {
        const frag = result.url.split("#")[1] || result.url.split("?")[1] || "";
        const sid = new URLSearchParams(frag).get("session_id");
        console.log(`[KODA_AUTH_G] sid=${sid ? sid.slice(0, 8) + "..." : "null"}`);
        if (sid) {
          const res = await api.authGoogleSession(sid);
          console.log(`[KODA_AUTH_G] backend OK email=${res.email}`);
          await persistToken(res.session_token);
          await refresh();
        } else {
          throw new Error("google no session_id in redirect url");
        }
      } else {
        throw new Error(`google flow not success: type=${result.type}`);
      }
    } catch (e: any) {
      console.log(`[KODA_AUTH_G] ERROR: ${e?.message || e}`);
      throw e;
    }
  }, [refresh]);

  const signInApple = useCallback(async () => {
    if (Platform.OS !== "ios") throw new Error("Apple disponibile solo nell'app iOS");
    const AppleAuthentication = await import("expo-apple-authentication");
    // === DIAG 2026-07-16 (utente: "sono entrato una volta, ora non più") ===
    // Log dettagliato di ogni step Apple.
    try {
      console.log(`[KODA_AUTH_A] start`);
      const cred = await AppleAuthentication.signInAsync({
        requestedScopes: [
          AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
          AppleAuthentication.AppleAuthenticationScope.EMAIL,
        ],
      });
      const hasToken = !!cred.identityToken;
      console.log(`[KODA_AUTH_A] cred received hasToken=${hasToken} email=${cred.email ? "yes" : "no"} name=${cred.fullName ? "yes" : "no"}`);
      if (!hasToken) {
        throw new Error("apple identityToken missing");
      }
      const fullName = cred.fullName
        ? `${cred.fullName.givenName || ""} ${cred.fullName.familyName || ""}`.trim()
        : undefined;
      const res = await api.authApple(cred.identityToken || "", cred.email || undefined, fullName);
      console.log(`[KODA_AUTH_A] backend OK email=${res.email}`);
      await persistToken(res.session_token);
      await refresh();
    } catch (e: any) {
      console.log(`[KODA_AUTH_A] ERROR: ${e?.code || ""} ${e?.message || e}`);
      throw e;
    }
  }, [refresh]);

  const signOut = useCallback(async () => {
    try {
      await api.authLogout();
    } catch {}
    await persistToken(null);
    setUser(null);
  }, []);

  return (
    <AuthCtx.Provider value={{ user, loading, signInGoogle, signInApple, signOut, refresh }}>
      {children}
    </AuthCtx.Provider>
  );
}
