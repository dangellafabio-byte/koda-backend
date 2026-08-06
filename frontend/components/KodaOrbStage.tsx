/**
 * KodaOrbStage — Componente condiviso per il posizionamento dell'orb.
 *
 * === PERCHÉ ESISTE ===
 * Prima esisteva la stessa struttura di layout duplicata in due posti:
 *   1. app/index.tsx (Page 0 dell'horizontal pager)
 *   2. components/KodaIntroConversational.tsx (schermata intro-v2)
 *
 * La duplicazione portava a divergenze visive (paddingTop stimato a mano,
 * risultato: l'orb dell'intro non si allineava con quello della home).
 *
 * === COSA FA ===
 * Riproduce ESATTAMENTE la struttura verticale di Page 0 della home:
 *   - outer View: width=windowWidth, flex:1, center, paddingTop:90
 *   - inner View: flex:1, center, gap:18, paddingHorizontal:24
 *
 * Chi lo usa passa il proprio contenuto (orb + eventuale label) come
 * children. Il posizionamento verticale dell'orb è quindi garantito
 * identico ovunque il componente sia montato in un contenitore flex:1
 * che occupa tutta la viewport (root screen, ScrollView pager, ecc.).
 *
 * === REGOLA D'ORO ===
 * NON modificare paddingTop, gap, paddingHorizontal o la nesting
 * outer/inner senza aggiornare la home in parallelo. Sono l'ANCORA che
 * garantisce parità di posizione fra Home e Intro.
 */
import React from "react";
import { StyleSheet, View, useWindowDimensions } from "react-native";

export function useOrbSize(): number {
  const { width } = useWindowDimensions();
  return Math.min(width * 0.78, 360);
}

export default function KodaOrbStage({ children }: { children: React.ReactNode }) {
  const { width: windowWidth } = useWindowDimensions();
  return (
    <View style={[styles.outer, { width: windowWidth }]}>
      <View style={styles.inner}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  outer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    // ANCORA VERTICALE — vedi commento in cima. Non toccare senza aggiornare
    // anche l'utilizzo nella home (app/index.tsx Page 0).
    paddingTop: 90,
  },
  inner: {
    alignItems: "center",
    justifyContent: "center",
    flex: 1,
    gap: 18,
    paddingHorizontal: 24,
  },
});
