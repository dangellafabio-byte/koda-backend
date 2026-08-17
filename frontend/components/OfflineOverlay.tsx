/**
 * OfflineOverlay — Overlay non-invasivo per assenza di rete.
 *
 * Design (Fabio 2026-08-14):
 *  • Usa @react-native-community/netinfo per rilevare cambio stato rete.
 *  • Debounce di 1500ms sull'evento "offline" per evitare falsi positivi
 *    da micro-blip di connessione (comuni sulla LTE in movimento).
 *  • Overlay a bandana orizzontale in ALTO, sotto la safe-area (non
 *    blocca l'orb centrale né il flow di conversazione). Il layer è
 *    pointer-events="none" quindi NON intercetta i tap sull'app.
 *  • Testo caldo, non allarmista: "Sei fuori linea. Le parole restano
 *    con te — Koda ti risponderà quando torni." Coerente con Koda:
 *    la rete che manca non è "errore", è momento di attesa.
 *  • Auto-rientra (scompare) appena la rete torna disponibile.
 *  • Zero background polling, zero fetch, zero timer periodici — usa
 *    solo la subscription di NetInfo (event-driven, batteria-friendly).
 *  • Compatibile con expo-router: si monta a livello _layout, sempre
 *    presente su ogni screen.
 *
 * NB: Su iOS/Android nativi, NetInfo rileva anche "connected but no
 * internet" (Captive portal, WiFi senza gateway). Su web è meno accurato
 * ma è comunque un miglioramento rispetto a nulla.
 */
import React, { useEffect, useRef, useState } from "react";
import { View, Text, StyleSheet, Animated, Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import NetInfo, { NetInfoState } from "@react-native-community/netinfo";

// Debounce prima di mostrare l'overlay: evita blip micro-secondi di LTE
const OFFLINE_DEBOUNCE_MS = 1500;
// Fade animation
const FADE_DURATION_MS = 300;

export default function OfflineOverlay() {
  const insets = useSafeAreaInsets();
  const [visible, setVisible] = useState(false);
  const opacity = useRef(new Animated.Value(0)).current;
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Snapshot dell'ultimo stato "isConnected" ricevuto — per evitare
  // toggle continuo su handler che ripetono lo stesso valore.
  const lastConnectedRef = useRef<boolean | null>(null);

  useEffect(() => {
    const handleState = (state: NetInfoState) => {
      // isInternetReachable è più affidabile di isConnected (che è true
      // anche su WiFi senza gateway). Ma su iOS può essere null all'inizio.
      // Regola: OFFLINE se isConnected=false OPPURE isInternetReachable=false.
      // Se entrambi null (init), assumiamo online.
      const connected =
        state.isConnected !== false &&
        state.isInternetReachable !== false;

      // Nessuna variazione → skip
      if (lastConnectedRef.current === connected) return;
      lastConnectedRef.current = connected;

      // Cancella eventuali debounce precedenti
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }

      if (connected) {
        // Torniamo online → nascondi immediatamente, senza debounce
        setVisible(false);
      } else {
        // Andiamo offline → aspetta il debounce per evitare falsi positivi
        debounceRef.current = setTimeout(() => {
          setVisible(true);
          debounceRef.current = null;
        }, OFFLINE_DEBOUNCE_MS);
      }
    };

    // Legge subito lo stato corrente
    NetInfo.fetch().then(handleState).catch(() => {});

    // Subscribe agli eventi
    const unsub = NetInfo.addEventListener(handleState);

    return () => {
      unsub();
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
  }, []);

  // Fade in/out coerente col visibility
  useEffect(() => {
    Animated.timing(opacity, {
      toValue: visible ? 1 : 0,
      duration: FADE_DURATION_MS,
      useNativeDriver: true,
    }).start();
  }, [visible, opacity]);

  // NB: pointerEvents="none" garantisce che l'overlay non blocca mai
  // i tap sull'UI sottostante. Zero rischio di intercettare gesture.
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.wrapper,
        {
          opacity,
          paddingTop: insets.top + 8,
        },
      ]}
      accessible={visible}
      accessibilityRole="alert"
      accessibilityLabel="Sei fuori linea. Koda ti risponderà quando torni online."
      testID="offline-overlay"
    >
      <View style={styles.pill}>
        <View style={styles.dot} />
        <Text style={styles.text} numberOfLines={2}>
          Sei fuori linea. Le parole restano con te — Koda ti risponderà quando torni.
        </Text>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 9999,
    alignItems: "center",
    paddingHorizontal: 16,
  },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    // Cassa scura semi-trasparente, coerente col tema notturno di Koda.
    // Bordo tenue per staccare da qualsiasi background (funziona sia
    // su tema notte che tema giorno / cielo / bosco / ciliegia).
    backgroundColor: "rgba(20, 20, 24, 0.92)",
    borderColor: "rgba(255, 255, 255, 0.10)",
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 20,
    paddingVertical: 10,
    paddingHorizontal: 14,
    maxWidth: 520,
    // Shadow leggerissima (iOS) / elevation (Android) per staccare
    // dal contenuto sotto senza essere aggressivi.
    ...Platform.select({
      ios: {
        shadowColor: "#000",
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.35,
        shadowRadius: 6,
      },
      android: {
        elevation: 4,
      },
      default: {},
    }),
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    // Ambra tenue — non "rosso allarme". Presenza gentile.
    backgroundColor: "#E0B872",
    marginRight: 10,
  },
  text: {
    color: "#F5F1E8",
    fontSize: 13,
    lineHeight: 18,
    flexShrink: 1,
    fontWeight: "500",
  },
});
