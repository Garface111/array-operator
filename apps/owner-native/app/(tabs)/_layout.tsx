import { Tabs } from "expo-router";
import { Pressable, Text } from "react-native";
import { useAgent } from "@/lib/AgentContext";
import { sky } from "@/lib/theme";

function TabLabel({ label, focused }: { label: string; focused: boolean }) {
  return (
    <Text
      style={{
        fontSize: 10,
        fontWeight: "800",
        color: focused ? sky.primaryDeep : sky.muted,
        marginBottom: 2,
      }}
    >
      {label}
    </Text>
  );
}

/** Desktop parity: Fleet · Analysis · Invoices · Repairs · Marketplace · Account */
export default function TabLayout() {
  const { openAgent } = useAgent();

  return (
    <Tabs
      screenOptions={{
        headerStyle: {
          backgroundColor: sky.glassChrome,
        },
        headerTitleStyle: {
          fontWeight: "800",
          color: sky.ink,
          fontSize: 15,
        },
        headerShadowVisible: false,
        headerRight: () => (
          <Pressable
            onPress={() => openAgent()}
            style={{
              marginRight: 12,
              backgroundColor: sky.primary,
              borderRadius: 16,
              paddingHorizontal: 12,
              paddingVertical: 7,
            }}
          >
            <Text style={{ color: "#fff", fontWeight: "800", fontSize: 12 }}>
              Agent
            </Text>
          </Pressable>
        ),
        tabBarStyle: {
          backgroundColor: sky.glassChrome,
          borderTopColor: sky.line,
          height: 58,
          paddingTop: 4,
        },
        tabBarShowLabel: true,
        tabBarActiveTintColor: sky.primaryDeep,
        tabBarInactiveTintColor: sky.muted,
      }}
    >
      <Tabs.Screen
        name="fleet"
        options={{
          title: "Array Operator",
          tabBarLabel: ({ focused }) => (
            <TabLabel label="Fleet" focused={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="analysis"
        options={{
          title: "Analysis",
          tabBarLabel: ({ focused }) => (
            <TabLabel label="Analysis" focused={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="invoices"
        options={{
          title: "Invoices",
          tabBarLabel: ({ focused }) => (
            <TabLabel label="Invoices" focused={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="repairs"
        options={{
          title: "Repairs",
          tabBarLabel: ({ focused }) => (
            <TabLabel label="Repairs" focused={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="marketplace"
        options={{
          title: "Marketplace",
          tabBarLabel: ({ focused }) => (
            <TabLabel label="Market" focused={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="account"
        options={{
          title: "Account",
          tabBarLabel: ({ focused }) => (
            <TabLabel label="Account" focused={focused} />
          ),
        }}
      />
      <Tabs.Screen name="index" options={{ href: null }} />
    </Tabs>
  );
}
