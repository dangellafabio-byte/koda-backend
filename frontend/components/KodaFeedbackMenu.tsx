/**
 * KodaFeedbackMenu — Bottom sheet per feedback su turno Koda.
 * Fabio 2026-09-11.
 *
 * Trigger: long-press sulla bolla AI (>500ms). Il menu mostra:
 *   - 👍 "È stata giusta" (positive)
 *   - 👎 con 5 categorie: Troppo fredda / intensa / Non mi ha capito /
 *     Fuori momento / Altro
 *
 * Privacy: passa solo `eventId` (UUID capability generato dal server).
 * Zero user_id, zero testo trasferito. Vedi lib/feedback.ts.
 *
 * UX:
 *   - Modal centered, backdrop tap → chiude senza feedback
 *   - Auto-close 500ms dopo submit con haptic light
 *   - Zero notifica di "grazie" a schermo — il gesto stesso è la conferma
 */
import React, { useState } from "react";
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
  ActivityIndicator,
} from "react-native";
import * as Haptics from "expo-haptics";
import {
  submitFeedback,
  FEEDBACK_CATEGORY_LABELS,
  type FeedbackCategory,
} from "../lib/feedback";

type Props = {
  eventId: string | null;
  onClose: () => void;
  /** Colori dinamici dal tema chat corrente. */
  bgColor?: string;
  fgColor?: string;
  accentColor?: string;
};

export function KodaFeedbackMenu({
  eventId,
  onClose,
  bgColor = "#1F1F1F",
  fgColor = "#F5F5F5",
  accentColor = "#FCD34D",
}: Props) {
  const visible = !!eventId;
  const [phase, setPhase] = useState<"idle" | "sending" | "done">("idle");
  const [showCategories, setShowCategories] = useState(false);

  const reset = () => {
    setPhase("idle");
    setShowCategories(false);
  };

  const closeAll = () => {
    reset();
    onClose();
  };

  const handlePositive = async () => {
    if (!eventId || phase !== "idle") return;
    setPhase("sending");
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    await submitFeedback(eventId, "positive", null);
    setPhase("done");
    setTimeout(closeAll, 400);
  };

  const handleNegativeCategory = async (cat: FeedbackCategory) => {
    if (!eventId || phase !== "idle") return;
    setPhase("sending");
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    await submitFeedback(eventId, "negative", cat);
    setPhase("done");
    setTimeout(closeAll, 400);
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={closeAll}
    >
      <Pressable style={styles.backdrop} onPress={closeAll}>
        <Pressable style={[styles.sheet, { backgroundColor: bgColor }]}>
          {phase === "sending" ? (
            <ActivityIndicator color={accentColor} />
          ) : phase === "done" ? (
            <Text style={[styles.doneText, { color: fgColor }]}>Grazie</Text>
          ) : !showCategories ? (
            <>
              <Text style={[styles.title, { color: fgColor }]}>
                {"Com'è stata questa risposta?"}
              </Text>
              <View style={styles.row}>
                <Pressable
                  style={[styles.big, { borderColor: accentColor }]}
                  onPress={handlePositive}
                  hitSlop={12}
                >
                  <Text style={styles.emoji}>👍</Text>
                  <Text style={[styles.bigLabel, { color: fgColor }]}>
                    Giusta
                  </Text>
                </Pressable>
                <Pressable
                  style={[styles.big, { borderColor: accentColor }]}
                  onPress={() => setShowCategories(true)}
                  hitSlop={12}
                >
                  <Text style={styles.emoji}>👎</Text>
                  <Text style={[styles.bigLabel, { color: fgColor }]}>
                    Non ci siamo
                  </Text>
                </Pressable>
              </View>
            </>
          ) : (
            <>
              <Text style={[styles.title, { color: fgColor }]}>Cosa non ha funzionato?</Text>
              {(Object.keys(FEEDBACK_CATEGORY_LABELS) as FeedbackCategory[]).map((cat) => (
                <Pressable
                  key={cat}
                  style={styles.categoryRow}
                  onPress={() => handleNegativeCategory(cat)}
                >
                  <Text style={[styles.categoryLabel, { color: fgColor }]}>
                    {FEEDBACK_CATEGORY_LABELS[cat]}
                  </Text>
                </Pressable>
              ))}
              <Pressable style={styles.categoryRow} onPress={closeAll}>
                <Text style={[styles.categoryLabel, { color: fgColor, opacity: 0.5 }]}>
                  Annulla
                </Text>
              </Pressable>
            </>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 24,
  },
  sheet: {
    width: "100%",
    maxWidth: 400,
    borderRadius: 24,
    paddingVertical: 24,
    paddingHorizontal: 20,
    shadowColor: "#000",
    shadowOpacity: 0.3,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
  },
  title: {
    fontSize: 17,
    fontWeight: "600",
    textAlign: "center",
    marginBottom: 20,
  },
  row: {
    flexDirection: "row",
    justifyContent: "space-around",
    gap: 12,
  },
  big: {
    flex: 1,
    alignItems: "center",
    paddingVertical: 20,
    borderRadius: 18,
    borderWidth: 1.5,
  },
  emoji: { fontSize: 34, marginBottom: 6 },
  bigLabel: { fontSize: 14, fontWeight: "500" },
  categoryRow: {
    paddingVertical: 14,
    paddingHorizontal: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "rgba(255,255,255,0.1)",
  },
  categoryLabel: { fontSize: 16, textAlign: "center" },
  doneText: { fontSize: 20, fontWeight: "600", textAlign: "center", paddingVertical: 24 },
});
