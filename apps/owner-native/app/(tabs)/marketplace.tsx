import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Btn, Card, H1, SkyScreen, StatCard, Sub } from "@/components/ui";
import { useAgent } from "@/lib/AgentContext";
import { fetchSubscriptions } from "@/lib/api";
import { sky } from "@/lib/theme";

export default function MarketplaceScreen() {
  const { openAgent } = useAgent();
  const [arrayCount, setArrayCount] = useState(0);
  const [subCount, setSubCount] = useState(0);

  useEffect(() => {
    fetchSubscriptions()
      .then((b) => {
        setArrayCount(b.arrays?.length || 0);
        setSubCount(b.subscriptions?.length || 0);
      })
      .catch(() => undefined);
  }, []);

  return (
    <SkyScreen>
      <H1>Marketplace</H1>
      <Sub>Offtaker exchange · vacancy & demand</Sub>

      <View style={styles.row}>
        <StatCard label="Arrays" value={String(arrayCount)} meta="In billing bundle" />
        <StatCard label="Offtakers" value={String(subCount)} meta="On file" />
      </View>

      <Card style={{ marginTop: 12, gap: 10 }}>
        <Text style={styles.body}>
          Ask Energy Agent to measure vacancy with tools and capture demand leads
          on your waitlist — same capabilities as desktop Marketplace.
        </Text>
        <Btn
          title="Ask Agent about vacancy"
          primary
          onPress={() =>
            openAgent(
              "Marketplace brief: any unallocated credits / vacancy on my fleet, and how to list demand? Use tools."
            )
          }
        />
        <Btn
          title="Capture demand with Agent"
          onPress={() =>
            openAgent(
              "Help me capture offtaker demand for excess credits. Use tools if available."
            )
          }
        />
      </Card>
    </SkyScreen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", gap: 8 },
  body: {
    fontSize: 14,
    fontWeight: "600",
    color: sky.ink,
    lineHeight: 20,
  },
});
