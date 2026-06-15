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
    } catch {
      await persistToken(null);
      setUser(null);
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
    const result = await WebBrowser.openAuthSessionAsync(authUrl, redirect);
    if (result.type === "success" && result.url) {
      const frag = result.url.split("#")[1] || result.url.split("?")[1] || "";
      const sid = new URLSearchParams(frag).get("session_id");
      if (sid) {
        const res = await api.authGoogleSession(sid);
        await persistToken(res.session_token);
        await refresh();
      }
    }
  }, [refresh]);

  const signInApple = useCallback(async () => {
    if (Platform.OS !== "ios") throw new Error("Apple disponibile solo nell'app iOS");
    const AppleAuthentication = await import("expo-apple-authentication");
    const cred = await AppleAuthentication.signInAsync({
      requestedScopes: [
        AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
        AppleAuthentication.AppleAuthenticationScope.EMAIL,
      ],
    });
    const fullName = cred.fullName
      ? `${cred.fullName.givenName || ""} ${cred.fullName.familyName || ""}`.trim()
      : undefined;
    const res = await api.authApple(cred.identityToken || "", cred.email || undefined, fullName);
    await persistToken(res.session_token);
    await refresh();
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
