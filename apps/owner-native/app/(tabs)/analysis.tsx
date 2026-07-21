import { useEffect, useMemo, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import {
  Card,
  Chip,
  H1,
  Loading,
  OutputGauge,
  SkyScreen,
  Sparkline,
  StatCard,
  Sub,
} from "@/components/ui";
import { fetchFleetTree, fetchOverview } from "@/lib/api";
import { fmtKwh, fmtKw, fmtMoney, statusTone } from "@/lib/format";
import type { FleetArray, Overview } from "@/lib/types";
import { sky } from "@/lib/theme";

export default function AnalysisScreen() {
  const [arrays, setArrays] = useState<FleetArray[]>([]);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const [t, o] = await Promise.all([
          fetchFleetTree().catch(() => null),
          fetchOverview().catch(() => null),
        ]);
        setArrays(t?.arrays || []);
        setOverview(o);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const ranked = useMemo(() => {
    return [...arrays]
      .map((a) => {
        const peers = (a.inverters || [])
          .map((i) => i.peer_index)
          .filter((p): p is number => p != null && Number.isFinite(p));
        const avgPeer =
          peers.length > 0
            ? peers.reduce((s, p) => s + p, 0) / peers.length
            : null;
        return { a, avgPeer };
      })
      .sort((x, y) => {
        const rank = (t: ReturnType<typeof statusTone>) =>
          t === "bad" ? 0 : t === "warn" ? 1 : 2;
        const d = rank(statusTone(x.a.status)) - rank(statusTone(y.a.status));
        if (d !== 0) return d;
        return (x.avgPeer ?? 1) - (y.avgPeer ?? 1);
      });
  }, [arrays]);

  const fleetSpark = useMemo(() => {
    const byDate = new Map<string, number>();
    arrays.forEach((a) => {
      (a.daily || []).forEach((d) => {
        if (!d?.date) return;
        byDate.set(d.date, (byDate.get(d.date) || 0) + Number(d.kwh || 0));
      });
    });
    return [...byDate.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, kwh]) => ({ date, kwh }));
  }, [arrays]);

  const attn = ranked.filter(
    (r) =>
      statusTone(r.a.status) === "warn" || statusTone(r.a.status) === "bad"
  ).length;

  if (loading) {
    return (
      <SkyScreen scroll={false}>
        <Loading />
      </SkyScreen>
    );
  }

  return (
    <SkyScreen>
      <H1>Analysis</H1>
      <Sub>Health, peers, and production pulse</Sub>

      <Card style={{ marginBottom: 12 }}>
        <View style={styles.trendHead}>
          <Text style={styles.label}>Fleet trend</Text>
          <Sparkline series={fleetSpark} width={140} height={32} />
        </View>
        <View style={styles.row}>
          <StatCard
            label="Today"
            value={fmtKwh(overview?.totals?.today_kwh)}
            meta={
              overview?.totals?.today_usd != null
                ? `~${fmtMoney(overview.totals.today_usd)}`
                : "Production"
            }
          />
          <StatCard
            label="Attention"
            value={String(overview?.peer_summary?.arrays_attention ?? attn)}
            meta="Arrays flagged"
          />
        </View>
      </Card>

      <Text style={styles.section}>Site ranking</Text>
      <View style={{ gap: 8 }}>
        {ranked.map(({ a, avgPeer }) => {
          const nameplate =
            a.nameplate_kw ||
            (a.inverters || []).reduce((s, i) => s + (i.nameplate_kw || 0), 0) ||
            null;
          return (
            <Card key={String(a.id)}>
              <View style={styles.siteRow}>
                <OutputGauge
                  powerW={a.current_power_w}
                  nameplateKw={nameplate}
                  size={44}
                />
                <View style={{ flex: 1, marginLeft: 10 }}>
                  <Text style={styles.name} numberOfLines={1}>
                    {a.name}
                  </Text>
                  <Text style={styles.meta}>
                    {fmtKw(a.current_power_w)} · {fmtKwh(a.today_kwh)} today
                    {avgPeer != null ? ` · peer ${avgPeer.toFixed(2)}` : ""}
                  </Text>
                  <Sparkline series={a.daily} width={110} height={22} />
                </View>
                <Chip status={a.status} />
              </View>
            </Card>
          );
        })}
        {!ranked.length ? (
          <Card>
            <Text style={styles.meta}>No fleet data yet for analysis.</Text>
          </Card>
        ) : null}
      </View>
    </SkyScreen>
  );
}

const styles = StyleSheet.create({
  trendHead: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 10,
  },
  label: {
    fontSize: 10,
    fontWeight: "800",
    color: sky.primaryDeep,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  row: { flexDirection: "row", gap: 8 },
  section: {
    fontSize: 14,
    fontWeight: "800",
    color: sky.ink,
    marginBottom: 8,
  },
  siteRow: { flexDirection: "row", alignItems: "center" },
  name: { fontSize: 14, fontWeight: "800", color: sky.ink },
  meta: { fontSize: 11, fontWeight: "600", color: sky.muted, marginTop: 2 },
});
