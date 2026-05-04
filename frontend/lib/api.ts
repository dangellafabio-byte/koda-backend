// Shared types + helpers for App Compass frontend
import { Platform } from "react-native";

export const API_BASE =
  (process.env.EXPO_PUBLIC_BACKEND_URL || "") + "/api";

export type AppItem = {
  id: string;
  name: string;
  description: string;
  platforms: string[];
  pricing: "free" | "freemium" | "paid" | string;
  price_detail?: string | null;
  pros: string[];
  cons: string[];
  best_for?: string | null;
  url?: string | null;
  icon_emoji?: string | null;
};

export type RecommendResponse = {
  id: string;
  query: string;
  summary: string;
  apps: AppItem[];
  created_at: string;
};

export type Category = {
  id: string;
  name: string;
  emoji: string;
  description: string;
  examples: string[];
};

export type Favorite = {
  id: string;
  app: AppItem;
  query?: string | null;
  created_at: string;
};

export type HistoryItem = {
  id: string;
  query: string;
  summary?: string | null;
  apps_count: number;
  created_at: string;
};

export const pricingColor = (p: string) => {
  switch ((p || "").toLowerCase()) {
    case "free":
      return { bg: "rgba(34,197,94,0.15)", text: "#4ADE80", label: "Gratis" };
    case "paid":
      return { bg: "rgba(239,68,68,0.15)", text: "#F87171", label: "A pagamento" };
    case "freemium":
    default:
      return { bg: "rgba(251,191,36,0.15)", text: "#FBBF24", label: "Freemium" };
  }
};

export const platformIcon = (p: string): string => {
  const k = p.toLowerCase();
  if (k.includes("ios")) return "logo-apple";
  if (k.includes("android")) return "logo-android";
  if (k.includes("web")) return "globe-outline";
  if (k.includes("desktop")) return "desktop-outline";
  return "apps-outline";
};

export const isWeb = Platform.OS === "web";
