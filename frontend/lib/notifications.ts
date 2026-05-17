/**
 * lib/notifications.ts — NO-OP STUB (Phase 4 EAS Build unblock)
 *
 * `expo-notifications` has been temporarily removed from the project because
 * the iOS Push Notifications capability has not yet been enabled in App Store
 * Connect for `com.lamicofraterno.app`. Local-only notifications technically
 * don't require `aps-environment`, but the `expo-notifications` config plugin
 * adds that entitlement unconditionally, which breaks `eas build` for our
 * AdHoc provisioning profile.
 *
 * This file keeps the SAME public API surface used by the rest of the app
 * (`scheduleAt`, `scheduleCheckin`, `cancelAllCheckins`, `cancelCheckin`,
 *  `scheduleWeeklyAppNotification`, `requestNotificationsPermission`, …)
 * so no other source file needs to change. Every call resolves to a benign
 * no-op (logged in dev).
 *
 * TODO: After Fase 4 ships, re-enable Push Notifications capability on
 *       App Store Connect and restore the real implementation from git.
 */

const ASKED_KEY = "compass_notif_asked_v1";
const SCHEDULED_KEY = "compass_notif_scheduled_v1";

const log = (...args: any[]) => {
  if (typeof __DEV__ !== "undefined" && __DEV__) {
    // eslint-disable-next-line no-console
    console.log("[notifications stub]", ...args);
  }
};

export async function requestNotificationsPermission(): Promise<boolean> {
  log("requestNotificationsPermission → false (stub)");
  return false;
}

export async function scheduleWeeklyAppNotification(_force = false): Promise<boolean> {
  log("scheduleWeeklyAppNotification (stub)");
  return false;
}

export async function cancelWeeklyAppNotification(): Promise<void> {
  log("cancelWeeklyAppNotification (stub)");
}

export async function scheduleAt(_args: {
  id: string;
  title: string;
  body?: string;
  date: Date;
  data?: Record<string, any>;
}): Promise<string | null> {
  log("scheduleAt (stub)", _args?.id);
  return null;
}

export async function cancelScheduled(_id: string): Promise<void> {
  log("cancelScheduled (stub)", _id);
}

export type CheckinSlot = "morning" | "evening";

export async function scheduleCheckin(_args: {
  slot: CheckinSlot;
  hour: number;
  minute: number;
  title?: string;
  body?: string;
}): Promise<boolean> {
  log("scheduleCheckin (stub)", _args?.slot);
  return false;
}

export async function cancelAllCheckins(): Promise<void> {
  log("cancelAllCheckins (stub)");
}

export async function cancelCheckin(_slot: CheckinSlot): Promise<void> {
  log("cancelCheckin (stub)", _slot);
}

export async function listScheduledCheckins(): Promise<{
  morning: boolean;
  evening: boolean;
}> {
  return { morning: false, evening: false };
}

export const NOTIF_KEYS = { ASKED_KEY, SCHEDULED_KEY };
