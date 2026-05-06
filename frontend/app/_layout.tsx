import React, { useEffect } from "react";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { View, StyleSheet, Platform } from "react-native";
import { scheduleWeeklyAppNotification } from "../lib/notifications";

export default function RootLayout() {
  useEffect(() => {
    if (Platform.OS === "web") return;
    const t = setTimeout(() => {
      scheduleWeeklyAppNotification().catch(() => {});
    }, 1500);
    return () => clearTimeout(t);
  }, []);

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <View style={styles.root}>
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: "#0B0F1A" },
            animation: "fade",
          }}
        />
      </View>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#0B0F1A" },
});
