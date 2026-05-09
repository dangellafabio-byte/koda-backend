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
    // Cancel any old "compass-weekly-app" leftover from the previous app concept
    const legacy = existing.find((n) => n.identifier === "compass-weekly-app");
    if (legacy) {
      try {
        await Notifications.cancelScheduledNotificationAsync(legacy.identifier);
      } catch {}
    }
    const already = existing.find((n) => n.identifier === "taccuino-weekly-recap");
    if (already && !force) return true;

    if (already) {
      await Notifications.cancelScheduledNotificationAsync(already.identifier);
    }

    await Notifications.scheduleNotificationAsync({
      identifier: "taccuino-weekly-recap",
      content: {
        title: "🪶 Sunto della settimana",
        body: "Apri il Taccuino: ho qualcosa da raccontarti su come è andata.",
        sound: "default",
        data: { type: "weekly-recap" },
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
    await Notifications.cancelScheduledNotificationAsync("taccuino-weekly-recap");
    // Also clean up the legacy identifier in case it still exists
    await Notifications.cancelScheduledNotificationAsync("compass-weekly-app");
  } catch {}
}

/**
 * Schedule a one-shot local notification at a specific Date.
 * Returns the scheduled identifier (or null on failure).
 * On WEB it uses an in-page setTimeout fallback (Notification API + alert).
 */
const webTimers: Record<string, any> = {};

export async function scheduleAt(args: {
  when: Date;
  title: string;
  body: string;
  id?: string;
}): Promise<string | null> {
  const id = args.id || `taccuino-${Date.now()}-${Math.floor(Math.random() * 9999)}`;
  const ms = args.when.getTime() - Date.now();
  if (ms <= 0) {
    // Fire immediately
    return fireNow(id, args.title, args.body);
  }

  if (Platform.OS === "web") {
    // Browser fallback: setTimeout + Notification API + alert
    try {
      // Ask permission if granted not yet
      // @ts-ignore
      if (typeof Notification !== "undefined" && Notification.permission === "default") {
        try {
          // @ts-ignore
          await Notification.requestPermission();
        } catch {}
      }
    } catch {}

    const handle = setTimeout(() => {
      try {
        // 1) Speak the message via TTS so the user actually HEARS it
        try {
          // Lazy import to avoid circular ref
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const { SpeechMod } = require("./speech");
          const phrase = `${args.title}. ${args.body}`;
          SpeechMod.speak(phrase, { language: "it-IT", tone: "urgent" });
        } catch {}

        // 2) Show the system browser notification (if granted)
        // @ts-ignore
        if (typeof Notification !== "undefined" && Notification.permission === "granted") {
          // @ts-ignore
          new Notification(args.title, { body: args.body, icon: "/icon.png" });
        }

        // 3) Three-tone insistent beep pattern (more attention-grabbing than a single tone)
        try {
          // @ts-ignore
          const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
          const playTone = (delay: number, freq: number, dur = 0.35) => {
            const o = ctx.createOscillator();
            const g = ctx.createGain();
            o.connect(g);
            g.connect(ctx.destination);
            o.frequency.value = freq;
            const start = ctx.currentTime + delay;
            g.gain.setValueAtTime(0.001, start);
            g.gain.exponentialRampToValueAtTime(0.45, start + 0.04);
            g.gain.exponentialRampToValueAtTime(0.001, start + dur);
            o.start(start);
            o.stop(start + dur + 0.05);
          };
          playTone(0, 880);
          playTone(0.45, 1108); // a higher tone
          playTone(0.9, 880);
        } catch {}
      } catch {}
      delete webTimers[id];
    }, ms);
    webTimers[id] = handle;
    return id;
  }

  // Native: schedule with expo-notifications
  if (!Device.isDevice) {
    // simulator — fall back to a JS setTimeout for testing
    setTimeout(() => {
      try {
        Notifications.scheduleNotificationAsync({
          identifier: id,
          content: { title: args.title, body: args.body, sound: "default" },
          trigger: null,
        }).catch(() => {});
      } catch {}
    }, ms);
    return id;
  }

  try {
    const granted = await requestNotificationsPermission();
    if (!granted) return null;
    await Notifications.scheduleNotificationAsync({
      identifier: id,
      content: {
        title: args.title,
        body: args.body,
        sound: "default",
        data: { type: "ai-action" },
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        date: args.when,
      } as any,
    });
    return id;
  } catch {
    return null;
  }
}

async function fireNow(id: string, title: string, body: string): Promise<string | null> {
  if (Platform.OS === "web") {
    try {
      // @ts-ignore
      if (typeof Notification !== "undefined" && Notification.permission === "granted") {
        // @ts-ignore
        new Notification(title, { body });
      } else if (typeof window !== "undefined") {
        // @ts-ignore
        window.alert(`${title}\n${body}`);
      }
    } catch {}
    return id;
  }
  try {
    await Notifications.scheduleNotificationAsync({
      identifier: id,
      content: { title, body, sound: "default" },
      trigger: null,
    });
  } catch {}
  return id;
}

export async function cancelScheduled(id: string): Promise<void> {
  try {
    if (Platform.OS === "web") {
      const h = webTimers[id];
      if (h) {
        clearTimeout(h);
        delete webTimers[id];
      }
      return;
    }
    await Notifications.cancelScheduledNotificationAsync(id);
  } catch {}
}

// =============================================================
// PROACTIVE CHECK-IN SCHEDULER
// =============================================================
// Identifiers we use so we can update/cancel idempotently.
const CHECKIN_IDS = {
  morning: "taccuino-checkin-morning",
  evening: "taccuino-checkin-evening",
} as const;

export type CheckinSlot = "morning" | "evening";

/**
 * Parse a "HH:MM" string into hour/minute. Defensive: returns sane defaults.
 */
function parseHHMM(s: string | undefined, fallback: [number, number]): [number, number] {
  if (!s) return fallback;
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return fallback;
  const h = Math.max(0, Math.min(23, parseInt(m[1], 10)));
  const mm = Math.max(0, Math.min(59, parseInt(m[2], 10)));
  return [h, mm];
}

/**
 * Compute the next Date in the future at a given local hour:minute.
 * If today's slot is already past, return tomorrow's slot.
 */
function nextOccurrenceAt(hour: number, minute: number): Date {
  const now = new Date();
  const target = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    hour,
    minute,
    0,
    0
  );
  if (target.getTime() <= now.getTime() + 30_000) {
    target.setDate(target.getDate() + 1);
  }
  return target;
}

/**
 * Schedule one check-in at the requested local hour. Idempotent — calling
 * twice for the same slot replaces the previous one.
 *
 * The notification carries the *generated* title/body from the backend in
 * the visible content, plus the full voice_text + tone in the `data` payload
 * so the index screen can pick them up on tap and have Coda speak them.
 */
export async function scheduleCheckin(args: {
  slot: CheckinSlot;
  hhmm: string;
  title: string;
  body: string;
  voiceText: string;
  tone: string;
}): Promise<string | null> {
  if (Platform.OS === "web") return null;
  if (!Device.isDevice) return null;

  try {
    const granted = await requestNotificationsPermission();
    if (!granted) return null;

    const id = CHECKIN_IDS[args.slot];
    // Always cancel the old one first (it might be at a different hour now).
    try {
      await Notifications.cancelScheduledNotificationAsync(id);
    } catch {}

    const [hour, minute] = parseHHMM(
      args.hhmm,
      args.slot === "morning" ? [8, 30] : [21, 30]
    );
    const when = nextOccurrenceAt(hour, minute);

    await Notifications.scheduleNotificationAsync({
      identifier: id,
      content: {
        title: args.title,
        body: args.body,
        sound: "default",
        data: {
          type: "checkin",
          slot: args.slot,
          voice_text: args.voiceText,
          tone: args.tone,
          generated_at: Date.now(),
        },
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        date: when,
      } as any,
    });
    return id;
  } catch {
    return null;
  }
}

/**
 * Cancel both check-in slots — used when the user disables them.
 */
export async function cancelAllCheckins(): Promise<void> {
  try {
    await Notifications.cancelScheduledNotificationAsync(CHECKIN_IDS.morning);
  } catch {}
  try {
    await Notifications.cancelScheduledNotificationAsync(CHECKIN_IDS.evening);
  } catch {}
}

/**
 * Cancel a single check-in (e.g. user just talked to Coda within the last
 * few hours, so the upcoming one feels redundant).
 */
export async function cancelCheckin(slot: CheckinSlot): Promise<void> {
  try {
    await Notifications.cancelScheduledNotificationAsync(CHECKIN_IDS[slot]);
  } catch {}
}

/**
 * Returns identifiers of currently scheduled check-ins (handy for the
 * caller to know if it should re-generate fresh content for the next one).
 */
export async function listScheduledCheckins(): Promise<{
  morning: boolean;
  evening: boolean;
}> {
  if (Platform.OS === "web") return { morning: false, evening: false };
  try {
    const all = await Notifications.getAllScheduledNotificationsAsync();
    const ids = new Set(all.map((n) => n.identifier));
    return {
      morning: ids.has(CHECKIN_IDS.morning),
      evening: ids.has(CHECKIN_IDS.evening),
    };
  } catch {
    return { morning: false, evening: false };
  }
}

export const NOTIF_KEYS = { ASKED_KEY, SCHEDULED_KEY };
