import { Tabs } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { View, StyleSheet } from "react-native";

export default function RootLayout() {
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
