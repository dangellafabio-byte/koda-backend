import { Tabs } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { View, StyleSheet, Platform } from "react-native";
import { useEffect } from "react";
import * as Notifications from "expo-notifications";

// Schedule a weekly "App della Settimana" reminder on native builds.
// (No-op on web/Expo Go without a dev build.)
async function scheduleWeeklyReminder() {
  if (Platform.OS === "web") return;
  try {
    const perm = await Notifications.getPermissionsAsync();
    let granted = perm.granted;
    if (!granted) {
      const req = await Notifications.requestPermissionsAsync();
      granted = req.granted;
    }
    if (!granted) return;
    const existing = await Notifications.getAllScheduledNotificationsAsync();
    if (existing.some((n) => n.content.data?.kind === "weekly-app")) return;
    await Notifications.scheduleNotificationAsync({
      content: {
        title: "🧭 App della Settimana",
        body: "Apri App Compass per scoprire l'app consigliata di questa settimana.",
        data: { kind: "weekly-app" },
      },
      trigger: {
        weekday: 2, // Monday
        hour: 9,
        minute: 0,
        repeats: true,
      } as any,
    });
  } catch {}
}

export default function RootLayout() {
  useEffect(() => {
    scheduleWeeklyReminder();
  }, []);
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <View style={styles.root}>
        <Tabs
          screenOptions={{
            headerShown: false,
            tabBarStyle: styles.tabBar,
            tabBarActiveTintColor: "#FBBF24",
            tabBarInactiveTintColor: "#64748B",
            tabBarLabelStyle: styles.tabLabel,
            tabBarItemStyle: { paddingTop: 6 },
          }}
        >
          <Tabs.Screen
            name="index"
            options={{
              title: "Bussola",
              tabBarIcon: ({ color, size }) => (
                <Ionicons name="compass" size={size} color={color} />
              ),
            }}
          />
          <Tabs.Screen
            name="saved"
            options={{
              title: "Salvate",
              tabBarIcon: ({ color, size }) => (
                <Ionicons name="bookmark" size={size} color={color} />
              ),
            }}
          />
          <Tabs.Screen
            name="history"
            options={{
              title: "Cronologia",
              tabBarIcon: ({ color, size }) => (
                <Ionicons name="time" size={size} color={color} />
              ),
            }}
          />
        </Tabs>
      </View>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#020617" },
  tabBar: {
    backgroundColor: "rgba(2,6,23,0.96)",
    borderTopColor: "rgba(255,255,255,0.08)",
    borderTopWidth: 1,
    height: 74,
    paddingBottom: 14,
  },
  tabLabel: { fontSize: 11, fontWeight: "600", letterSpacing: 0.3 },
});
