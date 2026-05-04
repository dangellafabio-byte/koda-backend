import React from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Linking,
  Platform,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { AppItem, pricingColor, platformIcon } from "../lib/api";

type Props = {
  app: AppItem;
  saved?: boolean;
  selected?: boolean;
  onSave?: () => void;
  onToggleSelect?: () => void;
  onRemove?: () => void;
  onShare?: () => void;
  compact?: boolean;
};

export default function AppCard({
  app,
  saved,
  selected,
  onSave,
  onToggleSelect,
  onRemove,
  onShare,
  compact,
}: Props) {
  const pc = pricingColor(app.pricing);

  const openLink = async () => {
    if (!app.url) return;
    try {
      await Linking.openURL(app.url);
    } catch {}
  };

  return (
    <View
      style={[styles.card, selected && styles.cardSelected]}
      testID={`app-card-${app.name.toLowerCase().replace(/\s+/g, "-")}`}
    >
      <View style={styles.headerRow}>
        <View style={styles.iconBubble}>
          <Text style={styles.iconEmoji}>{app.icon_emoji || "📱"}</Text>
        </View>
        <View style={{ flex: 1, marginLeft: 12 }}>
          <Text style={styles.appName} numberOfLines={1}>
            {app.name}
          </Text>
          <View style={styles.platformRow}>
            {(app.platforms || []).slice(0, 4).map((p) => (
              <View key={p} style={styles.platformPill}>
                <Ionicons
                  name={platformIcon(p) as any}
                  size={11}
                  color="#CBD5E1"
                />
                <Text style={styles.platformText}>{p}</Text>
              </View>
            ))}
          </View>
        </View>
        <View style={[styles.pricingPill, { backgroundColor: pc.bg }]}>
          <Text style={[styles.pricingText, { color: pc.text }]}>
            {pc.label}
          </Text>
        </View>
      </View>

      <Text style={styles.description} numberOfLines={compact ? 2 : 4}>
        {app.description}
      </Text>

      {!compact && (app.pros?.length > 0 || app.cons?.length > 0) && (
        <View style={styles.prosContainer}>
          {app.pros?.slice(0, 3).map((p, i) => (
            <View key={`p-${i}`} style={styles.prosRow}>
              <Ionicons name="checkmark-circle" size={14} color="#4ADE80" />
              <Text style={styles.prosText}>{p}</Text>
            </View>
          ))}
          {app.cons?.slice(0, 2).map((c, i) => (
            <View key={`c-${i}`} style={styles.prosRow}>
              <Ionicons name="close-circle" size={14} color="#F87171" />
              <Text style={styles.prosText}>{c}</Text>
            </View>
          ))}
        </View>
      )}

      {!compact && app.price_detail ? (
        <Text style={styles.priceDetail}>💳 {app.price_detail}</Text>
      ) : null}

      <View style={styles.actionRow}>
        {app.url ? (
          <TouchableOpacity
            style={styles.primaryBtn}
            onPress={openLink}
            testID={`open-${app.name.toLowerCase().replace(/\s+/g, "-")}`}
          >
            <Ionicons name="open-outline" size={15} color="#020617" />
            <Text style={styles.primaryBtnText}>Apri</Text>
          </TouchableOpacity>
        ) : null}

        {onSave ? (
          <TouchableOpacity
            style={[styles.ghostBtn, saved && styles.ghostBtnActive]}
            onPress={onSave}
            testID={`save-${app.name.toLowerCase().replace(/\s+/g, "-")}`}
          >
            <Ionicons
              name={saved ? "bookmark" : "bookmark-outline"}
              size={15}
              color={saved ? "#FBBF24" : "#CBD5E1"}
            />
            <Text
              style={[styles.ghostBtnText, saved && { color: "#FBBF24" }]}
            >
              {saved ? "Salvata" : "Salva"}
            </Text>
          </TouchableOpacity>
        ) : null}

        {onToggleSelect ? (
          <TouchableOpacity
            style={[styles.ghostBtn, selected && styles.ghostBtnActiveAmber]}
            onPress={onToggleSelect}
            testID={`compare-toggle-${app.name.toLowerCase().replace(/\s+/g, "-")}`}
          >
            <Ionicons
              name={selected ? "checkbox" : "square-outline"}
              size={15}
              color={selected ? "#FBBF24" : "#CBD5E1"}
            />
            <Text
              style={[styles.ghostBtnText, selected && { color: "#FBBF24" }]}
            >
              Confronta
            </Text>
          </TouchableOpacity>
        ) : null}

        {onRemove ? (
          <TouchableOpacity
            style={styles.ghostBtn}
            onPress={onRemove}
            testID={`remove-${app.name.toLowerCase().replace(/\s+/g, "-")}`}
          >
            <Ionicons name="trash-outline" size={15} color="#F87171" />
            <Text style={[styles.ghostBtnText, { color: "#F87171" }]}>
              Rimuovi
            </Text>
          </TouchableOpacity>
        ) : null}

        {onShare ? (
          <TouchableOpacity
            style={styles.ghostBtn}
            onPress={onShare}
            testID={`share-${app.name.toLowerCase().replace(/\s+/g, "-")}`}
          >
            <Ionicons name="share-social-outline" size={15} color="#CBD5E1" />
            <Text style={styles.ghostBtnText}>Condividi</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: "rgba(255,255,255,0.04)",
    borderColor: "rgba(255,255,255,0.08)",
    borderWidth: 1,
    borderRadius: 22,
    padding: 18,
    marginBottom: 14,
    ...Platform.select({
      ios: {
        shadowColor: "#000",
        shadowOpacity: 0.3,
        shadowRadius: 10,
        shadowOffset: { width: 0, height: 4 },
      },
      android: { elevation: 3 },
    }),
  },
  cardSelected: {
    borderColor: "#FBBF24",
    backgroundColor: "rgba(251,191,36,0.07)",
  },
  headerRow: { flexDirection: "row", alignItems: "center" },
  iconBubble: {
    width: 48,
    height: 48,
    borderRadius: 16,
    backgroundColor: "rgba(251,191,36,0.12)",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "rgba(251,191,36,0.2)",
  },
  iconEmoji: { fontSize: 26 },
  appName: {
    fontSize: 17,
    fontWeight: "700",
    color: "#F8FAFC",
    letterSpacing: -0.3,
  },
  platformRow: { flexDirection: "row", flexWrap: "wrap", marginTop: 6, gap: 6 },
  platformPill: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.05)",
    borderRadius: 10,
    paddingHorizontal: 7,
    paddingVertical: 3,
    gap: 3,
  },
  platformText: { color: "#CBD5E1", fontSize: 10, fontWeight: "500" },
  pricingPill: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 10,
  },
  pricingText: { fontSize: 10, fontWeight: "700", letterSpacing: 0.3 },
  description: {
    color: "#CBD5E1",
    fontSize: 13.5,
    lineHeight: 19,
    marginTop: 12,
  },
  prosContainer: { marginTop: 10, gap: 5 },
  prosRow: { flexDirection: "row", alignItems: "flex-start", gap: 6 },
  prosText: { color: "#94A3B8", fontSize: 12.5, flex: 1, lineHeight: 17 },
  priceDetail: {
    color: "#FBBF24",
    fontSize: 12,
    fontWeight: "600",
    marginTop: 10,
  },
  actionRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginTop: 14,
  },
  primaryBtn: {
    backgroundColor: "#FBBF24",
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 999,
    gap: 5,
  },
  primaryBtnText: { color: "#020617", fontWeight: "700", fontSize: 13 },
  ghostBtn: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 999,
    gap: 5,
    backgroundColor: "rgba(255,255,255,0.04)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
  },
  ghostBtnActive: {
    backgroundColor: "rgba(251,191,36,0.1)",
    borderColor: "rgba(251,191,36,0.4)",
  },
  ghostBtnActiveAmber: {
    backgroundColor: "rgba(251,191,36,0.12)",
    borderColor: "rgba(251,191,36,0.5)",
  },
  ghostBtnText: { color: "#CBD5E1", fontWeight: "600", fontSize: 12.5 },
});
