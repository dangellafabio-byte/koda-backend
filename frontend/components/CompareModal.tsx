import React from "react";
import {
  View,
  Text,
  StyleSheet,
  Modal,
  ScrollView,
  TouchableOpacity,
  Dimensions,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { AppItem, pricingColor } from "../lib/api";

type Props = {
  visible: boolean;
  apps: AppItem[];
  onClose: () => void;
};

const { width } = Dimensions.get("window");
const COL_W = Math.min(240, Math.max(170, width * 0.55));

export default function CompareModal({ visible, apps, onClose }: Props) {
  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent={false}
      onRequestClose={onClose}
    >
      <View style={styles.container} testID="compare-modal">
        <View style={styles.header}>
          <View>
            <Text style={styles.overline}>CONFRONTO</Text>
            <Text style={styles.title}>Confronta {apps.length} app</Text>
          </View>
          <TouchableOpacity
            onPress={onClose}
            style={styles.closeBtn}
            testID="close-compare"
          >
            <Ionicons name="close" size={22} color="#F8FAFC" />
          </TouchableOpacity>
        </View>

        {apps.length < 2 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyText}>
              Seleziona almeno 2 app per confrontarle.
            </Text>
          </View>
        ) : (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 40 }}
          >
            {apps.map((a) => {
              const pc = pricingColor(a.pricing);
              return (
                <View key={a.id} style={[styles.col, { width: COL_W }]}>
                  <View style={styles.iconBubble}>
                    <Text style={{ fontSize: 28 }}>{a.icon_emoji || "📱"}</Text>
                  </View>
                  <Text style={styles.appName}>{a.name}</Text>

                  <View style={[styles.pricing, { backgroundColor: pc.bg }]}>
                    <Text style={[styles.pricingText, { color: pc.text }]}>
                      {pc.label}
                    </Text>
                  </View>

                  <Field label="Prezzo" value={a.price_detail || "—"} />
                  <Field
                    label="Piattaforme"
                    value={(a.platforms || []).join(" · ") || "—"}
                  />
                  <Field label="Ideale per" value={a.best_for || "—"} />

                  <Text style={styles.sectionLabel}>PRO</Text>
                  {(a.pros || []).map((p, i) => (
                    <Row key={`p${i}`} icon="checkmark-circle" color="#4ADE80" text={p} />
                  ))}

                  <Text style={styles.sectionLabel}>CONTRO</Text>
                  {(a.cons || []).map((c, i) => (
                    <Row key={`c${i}`} icon="close-circle" color="#F87171" text={c} />
                  ))}
                </View>
              );
            })}
          </ScrollView>
        )}
      </View>
    </Modal>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <Text style={styles.fieldValue}>{value}</Text>
    </View>
  );
}

function Row({
  icon,
  color,
  text,
}: {
  icon: string;
  color: string;
  text: string;
}) {
  return (
    <View style={styles.row}>
      <Ionicons name={icon as any} size={13} color={color} />
      <Text style={styles.rowText}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#020617", paddingTop: 54 },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingBottom: 18,
  },
  overline: {
    color: "#FBBF24",
    fontSize: 11,
    letterSpacing: 2,
    fontWeight: "700",
  },
  title: {
    color: "#F8FAFC",
    fontSize: 22,
    fontWeight: "700",
    marginTop: 4,
    letterSpacing: -0.5,
  },
  closeBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "rgba(255,255,255,0.06)",
    alignItems: "center",
    justifyContent: "center",
  },
  empty: { flex: 1, alignItems: "center", justifyContent: "center" },
  emptyText: { color: "#94A3B8", fontSize: 14 },
  col: {
    backgroundColor: "rgba(255,255,255,0.04)",
    borderColor: "rgba(255,255,255,0.08)",
    borderWidth: 1,
    borderRadius: 20,
    padding: 16,
    marginRight: 12,
  },
  iconBubble: {
    width: 56,
    height: 56,
    borderRadius: 18,
    backgroundColor: "rgba(251,191,36,0.12)",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 10,
  },
  appName: {
    color: "#F8FAFC",
    fontSize: 18,
    fontWeight: "700",
    letterSpacing: -0.3,
  },
  pricing: {
    alignSelf: "flex-start",
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 10,
    marginTop: 6,
    marginBottom: 12,
  },
  pricingText: { fontSize: 11, fontWeight: "700" },
  field: { marginBottom: 12 },
  fieldLabel: {
    color: "#64748B",
    fontSize: 10,
    letterSpacing: 1.5,
    fontWeight: "700",
    marginBottom: 4,
  },
  fieldValue: { color: "#E2E8F0", fontSize: 13, lineHeight: 18 },
  sectionLabel: {
    color: "#FBBF24",
    fontSize: 10,
    letterSpacing: 1.5,
    fontWeight: "700",
    marginTop: 6,
    marginBottom: 6,
  },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 6,
    marginBottom: 5,
  },
  rowText: { color: "#CBD5E1", fontSize: 12.5, flex: 1, lineHeight: 17 },
});
