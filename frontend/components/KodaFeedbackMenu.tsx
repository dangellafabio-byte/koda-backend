/**
 * KodaFeedbackMenu — Menu contestuale long-press sulla bolla AI.
 * Fabio 2026-09-11 (v2 semplificato).
 *
 * Design finale (4 righe):
 *   • Copia         — copia il testo della bolla negli appunti
 *   • Elimina       — rimuove la bolla dalla timeline
 *   • Cosa ha detto — feedback negativo, categoria wrong_content
 *   • Come l'ha detto — feedback negativo, categoria wrong_delivery
 *
 * Nessun 👍 esplicito: il silenzio è il segnale positivo.
 *
 * Privacy: passa solo `eventId` (UUID capability). Zero user_id, zero
 * testo verso il server. Vedi lib/feedback.ts.
 */
import React, { useState } from "react";
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  ActivityIndicator,
} from "react-native";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import {
  submitFeedback,
  FEEDBACK_CATEGORY_LABELS,
  FEEDBACK_CATEGORY_DESCRIPTIONS,
  type FeedbackCategory,
} from "../lib/feedback";

type Props = {
  /** UUID capability del turno; null = feedback readOnly (bolle pre-deploy) */
  eventId: string | null;
  /**
   * Forza apertura del menu anche senza eventId (readOnly).
   * Se true + eventId null → CTA feedback disabilitate con explainer temporale.
   * Se false + eventId null → menu chiuso.
   */
  visibleOverride?: boolean;
  /** Testo della bolla, per la voce "Copia" */
  bubbleText?: string;
  /** Handler per "Elimina" — di solito `ghostMessage` */
  onDelete?: () => void;
  /** Chiamato quando il menu si chiude (submit, cancel, backdrop) */
  onClose: () => void;
  bgColor?: string;
  fgColor?: string;
  accentColor?: string;
};

export function KodaFeedbackMenu({
  eventId,
  visibleOverride,
  bubbleText,
  onDelete,
  onClose,
  bgColor = "#1F1F1F",
  fgColor = "#F5F5F5",
  accentColor = "#FCD34D",
}: Props) {
  // === FIX 2026-09-11 B-bis (Fabio + Neo — bolle pre-deploy) ==============
  // Menu apribile in 2 modalità:
  //  1. FULL:      eventId presente → tutte le righe attive
  //  2. READ_ONLY: eventId null + visibleOverride=true → Copia/Elimina attive,
  //                le 2 righe feedback disabilitate con motivazione TEMPORALE
  //                (non "bug"). Zero chiamate network → nessun 404 possibile.
  //                Zero id generati lato client → nessun rischio privacy.
  const visible = !!eventId || !!visibleOverride;
  const readOnly = !eventId;
  const [phase, setPhase] = useState<"idle" | "sending" | "done">("idle");

  const reset = () => setPhase("idle");
  const closeAll = () => {
    reset();
    onClose();
  };

  const handleCopy = async () => {
    if (!bubbleText) {
      closeAll();
      return;
    }
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    try {
      await Clipboard.setStringAsync(bubbleText);
    } catch {}
    closeAll();
  };

  const handleDelete = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    try {
      onDelete?.();
    } catch {}
    closeAll();
  };

  const handleCategory = async (cat: FeedbackCategory) => {
    if (!eventId || phase !== "idle") return;
    setPhase("sending");
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    await submitFeedback(eventId, cat);
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
          ) : (
            <>
              <MenuRow
                label="Copia"
                fgColor={fgColor}
                onPress={handleCopy}
                disabled={!bubbleText}
              />
              <MenuRow
                label="Elimina"
                fgColor={fgColor}
                onPress={handleDelete}
                disabled={!onDelete}
              />
              <MenuRow
                label={FEEDBACK_CATEGORY_LABELS.wrong_content}
                subtitle={
                  readOnly
                    ? "Feedback disponibile solo sui messaggi nuovi"
                    : FEEDBACK_CATEGORY_DESCRIPTIONS.wrong_content
                }
                fgColor={fgColor}
                onPress={() => handleCategory("wrong_content")}
                disabled={readOnly}
              />
              <MenuRow
                label={FEEDBACK_CATEGORY_LABELS.wrong_delivery}
                subtitle={
                  readOnly
                    ? "Feedback disponibile solo sui messaggi nuovi"
                    : FEEDBACK_CATEGORY_DESCRIPTIONS.wrong_delivery
                }
                fgColor={fgColor}
                onPress={() => handleCategory("wrong_delivery")}
                disabled={readOnly}
                isLast
              />
            </>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function MenuRow({
  label,
  subtitle,
  fgColor,
  onPress,
  disabled,
  isLast,
}: {
  label: string;
  subtitle?: string;
  fgColor: string;
  onPress: () => void;
  disabled?: boolean;
  isLast?: boolean;
}) {
  return (
    <Pressable
      style={[
        styles.row,
        !isLast && styles.rowBorder,
        disabled && { opacity: 0.35 },
      ]}
      onPress={disabled ? undefined : onPress}
      disabled={disabled}
    >
      <Text style={[styles.rowLabel, { color: fgColor }]}>{label}</Text>
      {subtitle ? (
        <Text style={[styles.rowSubtitle, { color: fgColor }]}>{subtitle}</Text>
      ) : null}
    </Pressable>
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
    borderRadius: 22,
    paddingVertical: 6,
    shadowColor: "#000",
    shadowOpacity: 0.3,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
  },
  row: {
    paddingVertical: 16,
    paddingHorizontal: 22,
    minHeight: 48,
  },
  rowBorder: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(255,255,255,0.1)",
  },
  rowLabel: { fontSize: 17, fontWeight: "500" },
  rowSubtitle: { fontSize: 13, opacity: 0.55, marginTop: 2 },
  doneText: {
    fontSize: 18,
    fontWeight: "600",
    textAlign: "center",
    paddingVertical: 28,
  },
});
