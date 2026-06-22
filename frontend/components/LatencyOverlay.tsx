/**
 * LatencyOverlay — Pannello di debug per le latenze end-to-end.
 *
 * Si iscrive al latencyTracer e mostra i marker raccolti dal turno
 * corrente come una lista "T0+Δms LABEL". Pensato per essere visto
 * sul telefono nel furgone, senza Mac collegato.
 *
 * Visibilità: gestita dall'app via prop `visible`. L'utente la attiva
 * con un gesto nascosto (5 tap sull'avatar/orb).
 */
import React, { useEffect, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Platform } from "react-native";
import { traceSubscribe, traceReset, type Mark } from "../lib/latencyTracer";

export default function LatencyOverlay({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  const [marks, setMarks] = useState<Mark[]>([]);

  useEffect(() => {
    if (!visible) return;
    const unsub = traceSubscribe((m) => setMarks(m));
    return unsub;
  }, [visible]);

  if (!visible) return null;

  const total = marks.length > 0 ? marks[marks.length - 1].ms : 0;

  return (
    <View pointerEvents="box-none" style={styles.root}>
      <View style={styles.panel}>
        <View style={styles.header}>
          <Text style={styles.title}>⏱ Latenza turno</Text>
          <View style={{ flex: 1 }} />
          <TouchableOpacity onPress={() => traceReset()} style={styles.btn}>
            <Text style={styles.btnTxt}>Reset</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={onClose} style={styles.btn}>
            <Text style={styles.btnTxt}>✕</Text>
          </TouchableOpacity>
        </View>
        <ScrollView style={styles.list} showsVerticalScrollIndicator={false}>
          {marks.length === 0 ? (
            <Text style={styles.empty}>Nessun marker ancora. Manda un messaggio.</Text>
          ) : (
            marks.map((m, i) => {
              const prev = i > 0 ? marks[i - 1].ms : 0;
              const delta = m.ms - prev;
              return (
                <View key={`${m.label}-${i}`} style={styles.row}>
                  <Text style={styles.tMs}>T+{m.ms.toString().padStart(5, " ")}ms</Text>
                  <Text style={styles.tDelta}>(+{delta}ms)</Text>
                  <Text style={styles.tLabel}>{m.label}</Text>
                </View>
              );
            })
          )}
        </ScrollView>
        {marks.length > 0 ? (
          <Text style={styles.totalLine}>TOTALE: {total}ms ({(total / 1000).toFixed(2)}s)</Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    position: "absolute",
    top: Platform.OS === "ios" ? 60 : 30,
    left: 12,
    right: 12,
    zIndex: 9999,
  },
  panel: {
    backgroundColor: "rgba(0,0,0,0.88)",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.15)",
    paddingHorizontal: 12,
    paddingVertical: 10,
    maxHeight: 340,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 8,
  },
  title: {
    color: "#FCD34D",
    fontSize: 14,
    fontWeight: "700",
  },
  btn: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    backgroundColor: "rgba(255,255,255,0.12)",
    borderRadius: 6,
    marginLeft: 6,
  },
  btnTxt: {
    color: "#FFF",
    fontSize: 12,
    fontWeight: "600",
  },
  list: {
    maxHeight: 230,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 3,
  },
  tMs: {
    color: "#7DD3C0",
    fontSize: 12,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    minWidth: 70,
  },
  tDelta: {
    color: "#94A3B8",
    fontSize: 11,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    minWidth: 60,
    marginLeft: 6,
  },
  tLabel: {
    color: "#FFF",
    fontSize: 12,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    marginLeft: 8,
    flex: 1,
  },
  empty: {
    color: "#94A3B8",
    fontSize: 12,
    fontStyle: "italic",
    textAlign: "center",
    paddingVertical: 12,
  },
  totalLine: {
    color: "#FCD34D",
    fontSize: 12,
    fontWeight: "700",
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    textAlign: "right",
    marginTop: 6,
    paddingTop: 6,
    borderTopWidth: 1,
    borderTopColor: "rgba(255,255,255,0.1)",
  },
});
