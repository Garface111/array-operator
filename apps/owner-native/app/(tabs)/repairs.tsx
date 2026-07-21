import { useEffect, useMemo, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Card, Chip, H1, Loading, SkyScreen, Sub } from "@/components/ui";
import { fetchFleetTree } from "@/lib/api";
import { statusTone } from "@/lib/format";
import type { FleetArray } from "@/lib/types";
import { sky } from "@/lib/theme";

export default function RepairsScreen() {
  const [arrays, setArrays] = useState<FleetArray[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchFleetTree()
      .then((t) => setArrays(t.arrays || []))
      .catch(() => setArrays([]))
      .finally(() => setLoading(false));
  }, []);

  const issues = useMemo(() => {
    const rows: { name: string; status: string; kind: string }[] = [];
    arrays.forEach((a) => {
      const t = statusTone(a.status);
      if (t === "warn" || t === "bad")
        rows.push({ name: a.name, status: a.status, kind: "array" });
      (a.inverters || []).forEach((inv) => {
        const it = statusTone(inv.status);
        if (it === "warn" || it === "bad")
          rows.push({
            name: `${a.name} · ${inv.name}`,
            status: inv.status,
            kind: "inverter",
          });
      });
    });
    return rows;
  }, [arrays]);

  if (loading) {
    return (
      <SkyScreen scroll={false}>
        <Loading />
      </SkyScreen>
    );
  }

  return (
    <SkyScreen>
      <H1>Repairs</H1>
      <Sub>Detect · draft outreach · verify</Sub>

      <Card style={{ marginBottom: 12 }}>
        <Text style={styles.big}>{issues.length}</Text>
        <Text style={styles.meta}>
          Open attention items from live fleet health
        </Text>
      </Card>

      <View style={{ gap: 8 }}>
        {issues.length === 0 ? (
          <Card>
            <Text style={styles.meta}>
              Nothing flagged — fleet health looks clear.
            </Text>
          </Card>
        ) : (
          issues.map((row) => (
            <Card key={row.name}>
              <View style={styles.row}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.name}>{row.name}</Text>
                  <Text style={styles.meta}>{row.kind}</Text>
                </View>
                <Chip status={row.status} />
              </View>
            </Card>
          ))
        )}
      </View>
    </SkyScreen>
  );
}

const styles = StyleSheet.create({
  big: { fontSize: 36, fontWeight: "800", color: sky.ink },
  meta: { fontSize: 13, fontWeight: "600", color: sky.muted, marginTop: 4 },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  name: { fontSize: 14, fontWeight: "800", color: sky.ink },
});
