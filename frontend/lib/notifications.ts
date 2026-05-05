import * as Notifications from "expo-notifications";
import * as Device from "expo-device";
import { Platform } from "react-native";

const ASKED_KEY = "compass_notif_asked_v1";
const SCHEDULED_KEY = "compass_notif_scheduled_v1";

// Set foreground display behavior so users see the banner when app is open
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
    // Backwards-compatible alias (older SDKs)
    shouldShowAlert: true,
  } as any),
});

async function ensureAndroidChannel() {
  if (Platform.OS !== "android") return;
  try {
    await Notifications.setNotificationChannelAsync("weekly-app", {
      name: "App della settimana",
      importance: Notifications.AndroidImportance.DEFAULT,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: "#FBBF24",
    });
  } catch {}
}

export async function requestNotificationsPermission(): Promise<boolean> {
  if (Platform.OS === "web") return false;
  if (!Device.isDevice) return false;

  try {
    await ensureAndroidChannel();
    const settings = await Notifications.getPermissionsAsync();
    let status = settings.status;
    if (status !== "granted") {
      const req = await Notifications.requestPermissionsAsync({
        ios: {
          allowAlert: true,
          allowBadge: false,
          allowSound: true,
        },
      });
      status = req.status;
    }
    return status === "granted";
  } catch {
    return false;
  }
}

/**
 * Schedule a weekly local notification reminding about the App of the Week.
 * Runs every Monday at 09:00. Idempotent within a single install (unless `force`).
 */
export async function scheduleWeeklyAppNotification(force = false): Promise<boolean> {
  if (Platform.OS === "web") return false;
  if (!Device.isDevice) return false;

  try {
    const granted = await requestNotificationsPermission();
    if (!granted) return false;

    const existing = await Notifications.getAllScheduledNotificationsAsync();
    const already = existing.find((n) => n.identifier === "compass-weekly-app");
    if (already && !force) return true;

    if (already) {
      await Notifications.cancelScheduledNotificationAsync(already.identifier);
    }

    await Notifications.scheduleNotificationAsync({
      identifier: "compass-weekly-app",
      content: {
        title: "🧭 Nuova App della settimana",
        body: "Apri la Bussola e scopri quale app provare questa settimana.",
        sound: "default",
        data: { type: "weekly-app" },
      },
      // Weekly trigger: every Monday at 09:00 local time
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.WEEKLY,
        weekday: 2, // 1 = Sunday, 2 = Monday
        hour: 9,
        minute: 0,
        channelId: "weekly-app",
      } as any,
    });

    return true;
  } catch {
    return false;
  }
}

export async function cancelWeeklyAppNotification(): Promise<void> {
  try {
    await Notifications.cancelScheduledNotificationAsync("compass-weekly-app");
  } catch {}
}

export const NOTIF_KEYS = { ASKED_KEY, SCHEDULED_KEY };
