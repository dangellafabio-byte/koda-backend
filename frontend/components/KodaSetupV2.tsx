/**
 * KodaSetupV2 — Guscio del nuovo onboarding SETUP → INCONTRO.
 *
 * SCOPO: costruire e collegare il nuovo flusso Setup, SENZA modificare
 * l'Intro V2 già validata (KodaIntroConversational.tsx). Questo componente
 * termina con una dissolvenza verso `/intro-v2`, che eredita tutto il
 * comportamento esistente (turno 0/1 "Ciao", copione, voce, orb, timing).
 *
 * COSA FA
 *   Step 1 — Prima di iniziare (disclaimer, copy PROVVISORIO)
 *   Step 2 — Email (single field, minimo attrito)
 *   Step 3 — Microfono (pre-permission + prompt nativo iOS/Android)
 *   Step 4 — Dissolvenza → /intro-v2
 *
 * COSA NON FA (per esplicita policy di prodotto)
 *   - Non richiede voiceprint (in attesa di legale + Neo)
 *   - Non verifica l'email (nessuna magic link, nessun OTP)
 *   - Non modifica il profilo backend (in modalità TEST è ripetibile)
 *   - Non tocca produzione: accessibile solo dal bottone admin in Impostazioni
 *
 * MODALITÀ TEST / RIPETIBILITÀ
 *   Nessuno step scrive stato persistente (DB, SecureStore) durante il flusso.
 *   L'unica scrittura persistente avviene DENTRO Intro V2 alla fine (comportamento
 *   già esistente e validato). Per rifare il test: chiudi con back o esci a metà,
 *   ritocca il bottone admin, il flusso ricomincia da Step 1.
 *
 * COPY PROVVISORIA
 *   Tutte le stringhe utente-facing dello step "disclaimer" sono in COSTANTI
 *   in cima al file per essere facilmente sostituite dopo revisione legale.
 *
 * ANALYTICS
 *   Eventi minimi tramite api.analyticsTrack (già esistente):
 *     setup_v2_started
 *     setup_v2_disclaimer_continued
 *     setup_v2_email_submitted        { email_domain }
 *     setup_v2_microphone_permission_result  { granted, can_ask_again }
 *     setup_v2_intro_v2_started
 *
 * PERMESSO MICROFONO
 *   Usa ExpoSpeechRecognitionModule.requestPermissionsAsync() — la stessa
 *   che Intro V2 usa al turno 4. Concedendolo qui, l'utente non riceverà
 *   una seconda richiesta più tardi.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Easing,
  Keyboard,
  KeyboardAvoidingView,
  Linking,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ExpoSpeechRecognitionModule } from "expo-speech-recognition";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";

// ==================== COPY PROVVISORIA — LEGAL REVIEW PENDING ==================
// ⚠️  QUESTO TESTO È PROVVISORIO. Sarà sostituito dopo revisione legale.
// Tutte le stringhe utente-facing dello step "disclaimer" sono qui in cima al
// file per essere sostituibili senza toccare il resto della logica.
const DISCLAIMER_TITLE = "Prima di iniziare";
const DISCLAIMER_BODY_1 =
  "Koda è una presenza con cui puoi parlare, non un terapeuta e non sostituisce un professionista. Puoi usarla per parlare, sfogarti, mettere ordine nei pensieri o semplicemente stare un po' in compagnia.";
const DISCLAIMER_BODY_2 =
  "Se stai vivendo un'emergenza o hai bisogno di assistenza professionale, rivolgiti ai servizi appropriati.";
const DISCLAIMER_CTA = "Continua";

const EMAIL_TITLE = "La tua email";
const EMAIL_HINT = "Serve per riconoscerti tra un accesso e l'altro.";
const EMAIL_PLACEHOLDER = "tu@esempio.it";
const EMAIL_CTA = "Continua";

const MIC_PRE_TITLE = "Quasi pronto";
const MIC_PRE_BODY = "Koda ha bisogno del microfono per parlare con te.";
const MIC_PRE_CTA = "Concedi l'accesso";

const MIC_DENIED_TITLE = "Serve il microfono";
const MIC_DENIED_BODY =
  "Senza microfono Koda non può parlare con te. Puoi abilitarlo dalle impostazioni del sistema.";
const MIC_DENIED_RETRY_CTA = "Riprova";
const MIC_DENIED_SETTINGS_CTA = "Apri Impostazioni";
// ================================================================================

// ==================== ANALYTICS EVENTS =========================================
const EV_SETUP_STARTED = "setup_v2_started";
const EV_DISCLAIMER_CONTINUED = "setup_v2_disclaimer_continued";
const EV_EMAIL_SUBMITTED = "setup_v2_email_submitted";
const EV_MIC_PERMISSION_RESULT = "setup_v2_microphone_permission_result";
const EV_INTRO_STARTED = "setup_v2_intro_v2_started";

function track(event: string, props?: Record<string, unknown>) {
  api.analyticsTrack(event, props).catch(() => {
    /* fire-and-forget */
  });
}
// ================================================================================

type Step = "disclaimer" | "email" | "mic_pre" | "mic_denied" | "fading";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function KodaSetupV2() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const auth = useAuth() as { user?: { email?: string } | null };

  const [step, setStep] = useState<Step>("disclaimer");
  const [email, setEmail] = useState<string>(auth?.user?.email ?? "");
  const [busy, setBusy] = useState(false);
  const [micCanAskAgain, setMicCanAskAgain] = useState(true);

  const fadeOpacity = useRef(new Animated.Value(1)).current;

  // Analytics: setup_started al mount
  useEffect(() => {
    track(EV_SETUP_STARTED);
  }, []);

  const handleDisclaimerContinue = useCallback(() => {
    track(EV_DISCLAIMER_CONTINUED);
    // === SKIP EMAIL SE IDENTITÀ GIÀ NOTA (2026-08-08, Fabio) ===
    // OAuth (Google/Apple) è obbligatorio a monte del Setup V2 → auth.user.email
    // è già valorizzato con l'email verificata dal provider. Chiedere all'utente
    // di premere "Continua" su un campo pre-riempito è puro attrito senza
    // guadagno di dato (Neo l'aveva già confermato: quel campo non raccoglie,
    // solo mostra). Skippiamo lo step "email" andando direttamente a "mic_pre".
    //
    // Fallback: se per qualche motivo l'email non è valida (dev-login tester
    // senza email, OAuth con scope email negato, edge case), mostriamo lo
    // step "email" come oggi — nessuna regressione per il caso raro.
    //
    // Analytics: EV_EMAIL_SUBMITTED continua a firare sempre. Aggiungiamo
    // il campo `source` per distinguere `oauth_prefill` da `manual` e
    // misurare quanti utenti finiscono nel fallback.
    const prefilled = (auth?.user?.email || "").trim();
    if (EMAIL_RE.test(prefilled)) {
      const domain = prefilled.split("@")[1] || "unknown";
      track(EV_EMAIL_SUBMITTED, { email_domain: domain, source: "oauth_prefill" });
      setStep("mic_pre");
      return;
    }
    setStep("email");
  }, [auth?.user?.email]);

  const handleEmailSubmit = useCallback(() => {
    const trimmed = email.trim();
    if (!EMAIL_RE.test(trimmed)) return;
    Keyboard.dismiss();
    const domain = trimmed.split("@")[1] || "unknown";
    track(EV_EMAIL_SUBMITTED, { email_domain: domain, source: "manual" });
    setStep("mic_pre");
  }, [email]);

  const requestMic = useCallback(async () => {
    setBusy(true);
    try {
      const res = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
      const granted = !!res?.granted;
      const canAskAgain = res?.canAskAgain !== false;
      setMicCanAskAgain(canAskAgain);
      track(EV_MIC_PERMISSION_RESULT, {
        granted,
        can_ask_again: canAskAgain,
      });

      if (granted) {
        // Dissolvenza morbida verso Intro V2. Il replace evita che il back
        // torni al setup una volta iniziato l'incontro.
        setStep("fading");
        Animated.timing(fadeOpacity, {
          toValue: 0,
          duration: 900,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }).start(() => {
          track(EV_INTRO_STARTED);
          router.replace("/intro-v2");
        });
      } else {
        setStep("mic_denied");
      }
    } catch (e) {
      const errStr = String(e).slice(0, 80);
      console.warn("[SetupV2] mic request failed:", errStr);
      track(EV_MIC_PERMISSION_RESULT, { granted: false, error: errStr });
      setStep("mic_denied");
    } finally {
      setBusy(false);
    }
  }, [fadeOpacity, router]);

  const openSystemSettings = useCallback(() => {
    Linking.openSettings().catch(() => {
      /* silent */
    });
  }, []);

  return (
    <Animated.View
      style={[
        styles.root,
        {
          opacity: fadeOpacity,
          paddingTop: Math.max(insets.top, 20) + 12,
          paddingBottom: Math.max(insets.bottom, 20),
        },
      ]}
    >
      <StatusBar style="light" />

      {step === "disclaimer" && (
        <View style={styles.stepContainer}>
          <View style={styles.contentWrap}>
            <Text style={styles.stepTitle}>{DISCLAIMER_TITLE}</Text>
            <Text style={styles.stepBody}>{DISCLAIMER_BODY_1}</Text>
            <Text style={styles.stepBodyMuted}>{DISCLAIMER_BODY_2}</Text>
          </View>
          <TouchableOpacity
            style={styles.primaryBtn}
            onPress={handleDisclaimerContinue}
            testID="setup-v2-disclaimer-continue"
            activeOpacity={0.8}
          >
            <Text style={styles.primaryBtnText}>{DISCLAIMER_CTA}</Text>
          </TouchableOpacity>
        </View>
      )}

      {step === "email" && (
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          style={styles.stepContainer}
        >
          <View style={styles.contentWrap}>
            <Text style={styles.stepTitle}>{EMAIL_TITLE}</Text>
            <Text style={styles.stepBodyMuted}>{EMAIL_HINT}</Text>
            <TextInput
              value={email}
              onChangeText={setEmail}
              placeholder={EMAIL_PLACEHOLDER}
              placeholderTextColor="#5f5f6c"
              keyboardType="email-address"
              autoCapitalize="none"
              autoComplete="email"
              autoCorrect={false}
              style={styles.emailInput}
              testID="setup-v2-email-input"
              onSubmitEditing={handleEmailSubmit}
              returnKeyType="next"
              autoFocus
            />
          </View>
          <TouchableOpacity
            style={[
              styles.primaryBtn,
              !EMAIL_RE.test(email.trim()) && styles.primaryBtnDisabled,
            ]}
            onPress={handleEmailSubmit}
            disabled={!EMAIL_RE.test(email.trim())}
            testID="setup-v2-email-continue"
            activeOpacity={0.8}
          >
            <Text style={styles.primaryBtnText}>{EMAIL_CTA}</Text>
          </TouchableOpacity>
        </KeyboardAvoidingView>
      )}

      {step === "mic_pre" && (
        <View style={styles.stepContainer}>
          <View style={styles.contentWrap}>
            <Text style={styles.stepTitle}>{MIC_PRE_TITLE}</Text>
            <Text style={styles.stepBody}>{MIC_PRE_BODY}</Text>
          </View>
          <TouchableOpacity
            style={[styles.primaryBtn, busy && styles.primaryBtnDisabled]}
            onPress={requestMic}
            disabled={busy}
            testID="setup-v2-mic-request"
            activeOpacity={0.8}
          >
            {busy ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Text style={styles.primaryBtnText}>{MIC_PRE_CTA}</Text>
            )}
          </TouchableOpacity>
        </View>
      )}

      {step === "mic_denied" && (
        <View style={styles.stepContainer}>
          <View style={styles.contentWrap}>
            <Text style={styles.stepTitle}>{MIC_DENIED_TITLE}</Text>
            <Text style={styles.stepBody}>{MIC_DENIED_BODY}</Text>
          </View>
          {micCanAskAgain ? (
            <TouchableOpacity
              style={styles.primaryBtn}
              onPress={requestMic}
              testID="setup-v2-mic-retry"
              activeOpacity={0.8}
            >
              <Text style={styles.primaryBtnText}>{MIC_DENIED_RETRY_CTA}</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={styles.primaryBtn}
              onPress={openSystemSettings}
              testID="setup-v2-mic-open-settings"
              activeOpacity={0.8}
            >
              <Text style={styles.primaryBtnText}>{MIC_DENIED_SETTINGS_CTA}</Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      {step === "fading" && <View style={styles.stepContainer} />}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#06060A",
    paddingHorizontal: 24,
  },
  stepContainer: {
    flex: 1,
    justifyContent: "space-between",
  },
  contentWrap: {
    flex: 1,
    justifyContent: "center",
    paddingBottom: 48,
  },
  stepTitle: {
    color: "#FFFFFF",
    fontSize: 28,
    fontWeight: "600",
    marginBottom: 20,
    letterSpacing: 0.2,
  },
  stepBody: {
    color: "#E8E8EE",
    fontSize: 16,
    lineHeight: 24,
    marginBottom: 16,
  },
  stepBodyMuted: {
    color: "#8b8b98",
    fontSize: 14,
    lineHeight: 22,
    marginBottom: 24,
  },
  emailInput: {
    marginTop: 16,
    backgroundColor: "#15151d",
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    color: "#FFFFFF",
    fontSize: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#2a2a34",
  },
  primaryBtn: {
    backgroundColor: "#7A5CFF",
    borderRadius: 999,
    paddingVertical: 16,
    alignItems: "center",
    marginBottom: 24,
    minHeight: 52,
    justifyContent: "center",
  },
  primaryBtnDisabled: {
    backgroundColor: "#2a2a34",
  },
  primaryBtnText: {
    color: "#FFFFFF",
    fontSize: 16,
    fontWeight: "600",
    letterSpacing: 0.3,
  },
});
