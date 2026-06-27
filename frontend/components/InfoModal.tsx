import React from "react";
import {
  View,
  Text,
  Modal,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";

type Props = {
  visible: boolean;
  onClose: () => void;
  aiName?: string;
  theme: any;
};

type Section = {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  examples: string[];
};

const SECTIONS = (aiName: string): Section[] => [
  {
    icon: "person-circle-outline",
    title: "Chi è e come si chiama",
    examples: [
      `"Chiamati Luna" / "Stella" / "Pulse"`,
      `"Sii donna" / "Sii uomo" / "Sii neutra"`,
      `"Chiamami Marco" / "Da ora sono donna"`,
    ],
  },
  {
    icon: "chatbubble-ellipses-outline",
    title: "Come parla",
    examples: [
      `"Sii più breve" / "Sii più dettagliata"`,
      `"Parla più piano" / "Parla più veloce"`,
      `"Smetti di darmi del tesoro"`,
      `"Tono più caldo" / "più diretto" / "più dolce"`,
    ],
  },
  {
    icon: "lock-closed-outline",
    title: "Privacy & Stanza dello Sfogo",
    examples: [
      `"Apri lo Sfogo" / "Esci dallo Sfogo"`,
      `"Dimentica l'ultima cosa che ti ho detto"`,
      `"Dimentica tutto quello che sai su mio fratello"`,
      `"Cancella tutta la cronologia"`,
    ],
  },
  {
    icon: "notifications-outline",
    title: "Notifiche & Check-in",
    examples: [
      `"Dimmi buongiorno alle 8"`,
      `"Dimmi buonanotte alle 22"`,
      `"Mandami il riassunto stasera"`,
      `"Spegni le notifiche"`,
    ],
  },
  {
    icon: "alarm-outline",
    title: "Promemoria al volo",
    examples: [
      `"Ricordami di chiamare mamma tra un'ora"`,
      `"Svegliami alle 7 di mattina"`,
      `"Promemoria: medicina alle 14"`,
    ],
  },
  {
    icon: "color-palette-outline",
    title: "Aspetto",
    examples: [
      `"Tema scuro" / "Tema chiaro" / "Tema zen"`,
      `"Cambia voce"`,
    ],
  },
  {
    icon: "globe-outline",
    title: "Cose che fa per te",
    examples: [
      `"Cerca chi ha vinto la Champions"`,
      `"Che ore sono in Giappone?"`,
      `"Spiegami cos'è la crittografia E2E"`,
    ],
  },
];

const FOOTER_HINT = `Tutto si chiede a voce. Tocca il cerchio e parla.
Se chiedi qualcosa che non posso fare, te lo dico io.`;

export default function InfoModal({ visible, onClose, aiName = "Coda", theme }: Props) {
  const s = makeStyles(theme);
  const sections = SECTIONS(aiName);
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={s.overlay}>
        <View style={s.sheet}>
          <View style={s.header}>
            <View>
              <Text style={s.title}>Cosa puoi chiedere a {aiName}</Text>
              <Text style={s.subtitle}>Tutto a voce — niente impostazioni</Text>
            </View>
            <TouchableOpacity onPress={onClose} hitSlop={12}>
              <Ionicons name="close" size={26} color={theme.text} />
            </TouchableOpacity>
          </View>

          <ScrollView style={s.body} contentContainerStyle={{ paddingBottom: 24 }}>
            {sections.map((sec, i) => (
              <View key={i} style={s.section}>
                <View style={s.sectionHeader}>
                  <Ionicons name={sec.icon} size={20} color={theme.primary || "#A78BFA"} />
                  <Text style={s.sectionTitle}>{sec.title}</Text>
                </View>
                {sec.examples.map((ex, j) => (
                  <View key={j} style={s.example}>
                    <Text style={s.exampleText}>{ex}</Text>
                  </View>
                ))}
              </View>
            ))}
            <View style={s.footer}>
              <Text style={s.footerText}>{FOOTER_HINT}</Text>
            </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function makeStyles(theme: any) {
  // Il modal ha sfondo SCURO fisso (#15131F), quindi i testi devono essere
  // chiari indipendentemente dal tema globale dell'app (light/dark).
  const FG = "#FFFFFF";
  const FG_DIM = "rgba(255,255,255,0.72)";
  const ACCENT = theme.primary || "#A78BFA";
  return StyleSheet.create({
    overlay: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.55)",
      justifyContent: "flex-end",
    },
    sheet: {
      backgroundColor: "#15131F",
      borderTopLeftRadius: 24,
      borderTopRightRadius: 24,
      maxHeight: "85%",
      paddingTop: 16,
    },
    header: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 22,
      paddingBottom: 14,
      borderBottomWidth: 1,
      borderBottomColor: "rgba(255,255,255,0.10)",
    },
    title: {
      fontSize: 20,
      fontWeight: "700",
      color: FG,
    },
    subtitle: {
      fontSize: 13,
      color: FG_DIM,
      marginTop: 2,
    },
    body: {
      paddingHorizontal: 20,
      paddingTop: 12,
    },
    section: {
      marginBottom: 22,
    },
    sectionHeader: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      marginBottom: 8,
    },
    sectionTitle: {
      fontSize: 16,
      fontWeight: "600",
      color: FG,
    },
    example: {
      backgroundColor: "rgba(255,255,255,0.06)",
      borderRadius: 10,
      paddingVertical: 10,
      paddingHorizontal: 14,
      marginBottom: 6,
      borderLeftWidth: 2,
      borderLeftColor: ACCENT,
    },
    exampleText: {
      fontSize: 14,
      color: "rgba(255,255,255,0.92)",
      fontStyle: "italic",
    },
    footer: {
      marginTop: 8,
      paddingHorizontal: 6,
    },
    footerText: {
      fontSize: 13,
      color: FG_DIM,
      textAlign: "center",
      lineHeight: 19,
    },
  });
}
