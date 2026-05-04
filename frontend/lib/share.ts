import { Platform, Share } from "react-native";
import * as Clipboard from "expo-clipboard";

const BASE =
  typeof window !== "undefined" && window.location
    ? window.location.origin
    : process.env.EXPO_PUBLIC_BACKEND_URL || "";

export async function shareRecommendation(
  query: string,
  summary?: string
): Promise<"shared" | "copied" | "error"> {
  const url = `${BASE}/?q=${encodeURIComponent(query)}&auto=1`;
  const message = summary
    ? `🧭 App Compass consiglia per "${query}":\n\n${summary}\n\n${url}`
    : `🧭 App Compass — cosa usare per: "${query}"\n${url}`;

  try {
    if (Platform.OS === "web") {
      // @ts-ignore
      if (navigator.share) {
        // @ts-ignore
        await navigator.share({ title: "App Compass", text: message, url });
        return "shared";
      }
      await Clipboard.setStringAsync(url);
      return "copied";
    }
    await Share.share({ message, url });
    return "shared";
  } catch {
    try {
      await Clipboard.setStringAsync(url);
      return "copied";
    } catch {
      return "error";
    }
  }
}
