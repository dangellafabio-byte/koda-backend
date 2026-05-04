import { Platform, Share } from "react-native";
import * as Clipboard from "expo-clipboard";

const BASE =
  typeof window !== "undefined" && window.location
    ? window.location.origin
    : process.env.EXPO_PUBLIC_BACKEND_URL || "";

export type ShareStatus = "shared" | "copied" | "error";

async function doShare(message: string, url: string): Promise<ShareStatus> {
  try {
    if (Platform.OS === "web") {
      // @ts-ignore
      if (typeof navigator !== "undefined" && navigator.share) {
        // @ts-ignore
        await navigator.share({ title: "App Compass", text: message, url });
        return "shared";
      }
      await Clipboard.setStringAsync(message);
      return "copied";
    }
    await Share.share({ message, url });
    return "shared";
  } catch {
    try {
      await Clipboard.setStringAsync(message);
      return "copied";
    } catch {
      return "error";
    }
  }
}

export async function shareRecommendation(
  query: string,
  summary?: string
): Promise<ShareStatus> {
  const url = `${BASE}/?q=${encodeURIComponent(query)}&auto=1`;
  const message = summary
    ? `🧭 App Compass consiglia per "${query}":\n\n${summary}\n\n${url}`
    : `🧭 App Compass — cosa usare per: "${query}"\n${url}`;
  return doShare(message, url);
}

export async function shareSingleApp(args: {
  name: string;
  emoji?: string;
  description?: string;
  url?: string;
  query?: string;
}): Promise<ShareStatus> {
  const { name, emoji, description, url, query } = args;
  const linkUrl =
    url ||
    `${BASE}/?q=${encodeURIComponent(query || name)}&auto=1`;

  const lines: string[] = [];
  lines.push(`${emoji || "📱"} ${name}`);
  if (description) lines.push(description.length > 200 ? description.slice(0, 200).trim() + "…" : description);
  if (query) lines.push(`\nConsigliata da App Compass per: "${query}"`);
  lines.push(linkUrl);

  return doShare(lines.join("\n"), linkUrl);
}
