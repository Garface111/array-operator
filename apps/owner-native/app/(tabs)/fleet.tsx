import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  Card,
  Chip,
  H1,
  Loading,
  OutputGauge,
  PowerBar,
  Seg,
  SkyScreen,
  Sparkline,
  StatCard,
  Sub,
} from "@/components/ui";
import { fetchFleetTree, fetchOverview } from "@/lib/api";
import {
  brandLabel,
  fmtKwh,
  fmtKw,
  fmtMoney,
  statusTone,
} from "@/lib/format";
import type { FleetArray, Overview } from "@/lib/types";
import { sky } from "@/lib/theme";

export default function FleetScreen() {
  const [arrays, setArrays] = useState<FleetArray[]>([]);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [mode, setMode] = useState<"cards" | "table">("cards");
  const [q, setQ] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const [tree, ov] = await Promise.all([
        fetchFleetTree(),
        fetchOverview().catch(() => null),
      ]);
      setArrays(tree.arrays || []);
      setOverview(ov);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Load failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return arrays;
    return arrays.filter((a) =>
      [a.name, a.vendor, a.status, ...(a.inverters || []).map((i) => i.name)]
        .join(" ")
        .toLowerCase()
        .includes(s)
    );
  }, [arrays, q]);

  const stats = useMemo(() => {
    let inv = 0;
    let attn = 0;
    let liveW = 0;
    filtered.forEach((a) => {
      inv += a.inverters?.length || 0;
      const t = statusTone(a.status);
      if (t === "warn" || t === "bad") attn += 1;
      if (a.current_power_w != null) liveW += a.current_power_w;
    });
    return {
      n:
        overview?.totals?.array_count ??
        overview?.peer_summary?.arrays_total ??
        filtered.length,
      inv,
      attn,
      liveW,
      todayKwh: overview?.totals?.today_kwh,
      valueToday: overview?.totals?.today_usd,
    };
  }, [filtered, overview]);

  if (loading) {
    return (
      <SkyScreen scroll={false}>
        <Loading />
      </SkyScreen>
    );
  }

  return (
    <SkyScreen>
      <H1>Fleet</H1>
      <Sub>Live arrays · table view (desktop clone)</Sub>
      {err ? <Text style={styles.err}>{err}</Text> : null}

      <View style={styles.kpiRow}>
        <StatCard
          label="Arrays"
          value={String(stats.n)}
          meta={stats.inv ? `${stats.inv} inverters` : "Connect feeds"}
        />
        <StatCard
          label="Live now"
          value={fmtKw(stats.liveW || overview?.totals?.current_power_w)}
          meta={
            stats.valueToday != null
              ? `${fmtKwh(stats.todayKwh)} · ~${fmtMoney(stats.valueToday)}`
              : fmtKwh(stats.todayKwh)
          }
        />
      </View>
      <View style={[styles.kpiRow, { marginTop: 8 }]}>
        <StatCard
          label="Needs eyes"
          value={String(stats.attn)}
          meta={stats.attn ? "Status warn / bad" : "All clear"}
        />
        <StatCard label="Today" value={fmtKwh(stats.todayKwh)} meta="Fleet production" />
      </View>

      <View style={{ height: 12 }} />
      <Seg
        options={[
          { key: "cards", label: "Cards" },
          { key: "table", label: "Table" },
        ]}
        value={mode}
        onChange={(k) => setMode(k as "cards" | "table")}
      />

      <TextInput
        value={q}
        onChangeText={setQ}
        placeholder="Search arrays or inverters…"
        placeholderTextColor={sky.faint}
        style={styles.search}
      />

      {mode === "cards" ? (
        <View style={{ gap: 10 }}>
          {filtered.map((a) => {
            const id = String(a.id);
            const open = openId === id;
            const invs = a.inverters || [];
            const nameplate =
              a.nameplate_kw ||
              invs.reduce((s, i) => s + (i.nameplate_kw || 0), 0) ||
              null;
            return (
              <Card key={id} onPress={() => setOpenId(open ? null : id)}>
                <View style={styles.row}>
                  <OutputGauge powerW={a.current_power_w} nameplateKw={nameplate} />
                  <View style={{ flex: 1, marginLeft: 12 }}>
                    <View style={styles.rowBetween}>
                      <Text style={styles.name} numberOfLines={1}>
                        {a.name}
                      </Text>
                      <Chip status={a.status} />
                    </View>
                    <Text style={styles.meta}>
                      {brandLabel(a.vendor)}
                      {invs.length ? ` · ${invs.length} inv` : ""}
                      {a.today_kwh != null ? ` · ${fmtKwh(a.today_kwh)} today` : ""}
                    </Text>
                    <View style={{ marginTop: 8 }}>
                      <PowerBar
                        powerW={a.current_power_w}
                        nameplateKw={nameplate}
                        label={fmtKw(a.current_power_w)}
                      />
                    </View>
                    <View style={[styles.rowBetween, { marginTop: 8 }]}>
                      <Sparkline series={a.daily} />
                      <Text style={styles.meta}>{open ? "Hide ▴" : "Inverters ▾"}</Text>
                    </View>
                  </View>
                </View>
                {open ? (
                  <View style={styles.invBox}>
                    {invs.length === 0 ? (
                      <Text style={styles.meta}>No inverter rows yet.</Text>
                    ) : (
                      invs.map((inv) => (
                        <View key={String(inv.id)} style={styles.invRow}>
                          <OutputGauge
                            powerW={inv.current_power_w}
                            nameplateKw={inv.nameplate_kw}
                            size={40}
                          />
                          <View style={{ flex: 1, marginLeft: 10 }}>
                            <Text style={styles.invName}>{inv.name}</Text>
                            <Text style={styles.meta}>
                              {fmtKw(inv.current_power_w)}
                              {inv.peer_index != null
                                ? ` · peer ${inv.peer_index.toFixed(2)}`
                                : ""}
                            </Text>
                          </View>
                          <Chip status={inv.status} />
                        </View>
                      ))
                    )}
                  </View>
                ) : null}
              </Card>
            );
          })}
        </View>
      ) : (
        <Card style={{ padding: 0, overflow: "hidden" }}>
          <View style={styles.thead}>
            {["Name", "Status", "Now", "Today"].map((h) => (
              <Text key={h} style={styles.th}>
                {h}
              </Text>
            ))}
          </View>
          {filtered.map((a) => {
            const id = String(a.id);
            const open = openId === id;
            const invs = a.inverters || [];
            return (
              <View key={id}>
                <Pressable
                  onPress={() => setOpenId(open ? null : id)}
                  style={styles.trow}
                >
                  <Text style={[styles.td, styles.tdName]} numberOfLines={1}>
                    {open ? "▾ " : "▸ "}
                    {a.name} ({invs.length})
                  </Text>
                  <View style={styles.td}>
                    <Chip status={a.status} />
                  </View>
                  <Text style={styles.td}>{fmtKw(a.current_power_w)}</Text>
                  <Text style={styles.td}>{fmtKwh(a.today_kwh)}</Text>
                </Pressable>
                {open
                  ? invs.map((inv) => (
                      <View key={String(inv.id)} style={styles.trowInv}>
                        <Text style={[styles.td, styles.tdName]} numberOfLines={1}>
                          ⌁ {inv.name}
                        </Text>
                        <View style={styles.td}>
                          <Chip status={inv.status} />
                        </View>
                        <Text style={styles.td}>{fmtKw(inv.current_power_w)}</Text>
                        <Text style={styles.td}>
                          {inv.peer_index != null
                            ? inv.peer_index.toFixed(2)
                            : "—"}
                        </Text>
                      </View>
                    ))
                  : null}
              </View>
            );
          })}
          <Text style={styles.tableFoot}>
            Spreadsheet view ported from desktop vendor table
          </Text>
        </Card>
      )}

      {!filtered.length ? (
        <Card>
          <Text style={styles.meta}>No arrays match.</Text>
        </Card>
      ) : null}
    </SkyScreen>
  );
}

const styles = StyleSheet.create({
  kpiRow: { flexDirection: "row", gap: 8 },
  search: {
    borderWidth: 1,
    borderColor: sky.line,
    backgroundColor: "rgba(255,255,255,0.85)",
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    fontWeight: "600",
    color: sky.ink,
    marginBottom: 12,
  },
  row: { flexDirection: "row", alignItems: "flex-start" },
  rowBetween: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  name: { flex: 1, fontSize: 15, fontWeight: "800", color: sky.ink },
  meta: { fontSize: 11, fontWeight: "600", color: sky.muted, marginTop: 2 },
  invBox: {
    marginTop: 12,
    borderTopWidth: 1,
    borderTopColor: sky.line,
    paddingTop: 10,
    gap: 8,
  },
  invRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.65)",
    borderRadius: 14,
    padding: 8,
  },
  invName: { fontSize: 12, fontWeight: "800", color: sky.ink },
  err: { color: sky.bad, fontWeight: "700", marginBottom: 8, fontSize: 12 },
  thead: {
    flexDirection: "row",
    paddingHorizontal: 10,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: sky.line,
    backgroundColor: "rgba(255,255,255,0.9)",
  },
  th: {
    flex: 1,
    fontSize: 10,
    fontWeight: "800",
    color: sky.primaryDeep,
    textTransform: "uppercase",
  },
  trow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 10,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: sky.line,
    backgroundColor: "rgba(33,150,243,0.04)",
  },
  trowInv: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: sky.line,
    backgroundColor: "rgba(255,255,255,0.4)",
  },
  td: { flex: 1, fontSize: 11, fontWeight: "700", color: sky.ink },
  tdName: { flex: 1.4, fontWeight: "800" },
  tableFoot: {
    padding: 10,
    fontSize: 10,
    fontWeight: "600",
    color: sky.muted,
  },
});
