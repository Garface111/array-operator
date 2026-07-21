import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Card, H1, SkyScreen, StatCard, Sub } from "@/components/ui";
import { fetchSubscriptions } from "@/lib/api";
import { sky } from "@/lib/theme";

export default function MarketplaceScreen() {
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

      <Card style={{ marginTop: 12 }}>
        <Text style={styles.body}>
          Surface unallocated group-net-metering excess and collect demand — same
          exchange concept as desktop Marketplace. Full listing/create flows
          continue on the web; this native shell shows your live counts.
        </Text>
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
