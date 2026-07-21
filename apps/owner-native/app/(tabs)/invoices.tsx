import { useEffect, useMemo, useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";
import {
  Btn,
  Card,
  Chip,
  H1,
  Loading,
  SkyScreen,
  StatCard,
  Sub,
} from "@/components/ui";
import { useAgent } from "@/lib/AgentContext";
import { fetchSendPipeline, fetchSubscriptions } from "@/lib/api";
import { fmtMoney } from "@/lib/format";
import type { OfftakerSub, SendPipeline } from "@/lib/types";
import { sky } from "@/lib/theme";

export default function InvoicesScreen() {
  const { openAgent } = useAgent();
  const [pipe, setPipe] = useState<SendPipeline | null>(null);
  const [subs, setSubs] = useState<OfftakerSub[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const [p, b] = await Promise.all([
          fetchSendPipeline().catch(() => null),
          fetchSubscriptions(),
        ]);
        setPipe(p);
        setSubs(b.subscriptions || []);
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Load failed");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return subs;
    return subs.filter((o) =>
      [
        o.name,
        o.customer_name,
        o.email,
        o.client_email,
        o.array_name,
        o.status,
        o.delivery_mode,
      ]
        .join(" ")
        .toLowerCase()
        .includes(s)
    );
  }, [subs, q]);

  const enabled = subs.filter((s) => s.enabled !== false).length;
  const last = pipe?.last;
  const delivered = last?.delivered ?? last?.sent;
  const inflight =
    (pipe?.inflight?.pending_drafts || 0) +
    (pipe?.inflight?.pending_approval || 0) +
    (pipe?.inflight?.waiting || 0);

  if (loading) {
    return (
      <SkyScreen scroll={false}>
        <Loading />
      </SkyScreen>
    );
  }

  return (
    <SkyScreen>
      <H1>Invoices</H1>
      <Sub>Offtakers · send pipeline · desktop parity</Sub>
      {err ? <Text style={styles.err}>{err}</Text> : null}

      <View style={styles.row}>
        <StatCard
          label="Offtakers"
          value={String(pipe?.total_enabled ?? enabled)}
          meta={`${subs.length} on file`}
        />
        <StatCard
          label="Mode"
          value={String(pipe?.default_delivery_mode || "—")}
          meta="Delivery default"
        />
      </View>
      <View style={[styles.row, { marginTop: 8 }]}>
        <StatCard
          label="Last cycle"
          value={delivered != null ? String(delivered) : "—"}
          meta={
            last?.period_label || last?.period_month
              ? String(last.period_label || last.period_month)
              : "No send yet"
          }
        />
        <StatCard
          label="In flight"
          value={String(inflight)}
          meta={
            last?.dollars != null
              ? `${fmtMoney(last.dollars)} last $`
              : "Drafts / waiting"
          }
        />
      </View>

      <View style={{ gap: 8, marginTop: 12 }}>
        <Btn
          title="Pipeline brief with Agent"
          primary
          onPress={() =>
            openAgent(
              "Summarize my offtaker invoice pipeline: shares, send mode, online pay, anything broken. Use tools."
            )
          }
        />
        <Btn
          title="Add offtakers with Agent"
          onPress={() =>
            openAgent(
              "Help me add offtakers. You can create them with tools — keep steps short."
            )
          }
        />
      </View>

      <Text style={styles.section}>Offtaker list</Text>
      <TextInput
        value={q}
        onChangeText={setQ}
        placeholder="Search offtakers…"
        placeholderTextColor={sky.faint}
        style={styles.search}
      />

      <View style={{ gap: 8 }}>
        {filtered.length === 0 ? (
          <Card>
            <Text style={styles.meta}>
              {subs.length === 0
                ? "No offtakers yet — add them on desktop or via Agent."
                : "No matches."}
            </Text>
          </Card>
        ) : (
          filtered.map((o, idx) => {
            const st =
              o.enabled === false
                ? "paused"
                : String(o.status || o.delivery_mode || "active");
            const share =
              o.share_pct ?? o.array_share_pct ?? o.allocation_pct ?? null;
            const displayName = String(o.name || o.customer_name || "").trim();
            const displayEmail = String(o.email || o.client_email || "").trim();
            return (
              <Card key={String(o.id ?? displayEmail ?? displayName ?? idx)}>
                <View style={styles.head}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.name}>
                      {displayName || `Offtaker ${idx + 1}`}
                    </Text>
                    <Text style={styles.meta} numberOfLines={1}>
                      {displayEmail || "—"}
                      {o.array_name ? ` · ${o.array_name}` : ""}
                    </Text>
                  </View>
                  <Chip status={st} />
                </View>
                {share != null ? (
                  <Text style={[styles.meta, { marginTop: 8 }]}>
                    {Number(share) <= 1
                      ? `${Math.round(Number(share) * 1000) / 10}% share`
                      : `${Number(share)}% share`}
                    {o.delivery_mode ? ` · ${o.delivery_mode}` : ""}
                  </Text>
                ) : null}
              </Card>
            );
          })
        )}
      </View>
    </SkyScreen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", gap: 8 },
  section: {
    marginTop: 16,
    marginBottom: 8,
    fontSize: 14,
    fontWeight: "800",
    color: sky.ink,
  },
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
    marginBottom: 10,
  },
  head: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  name: { fontSize: 14, fontWeight: "800", color: sky.ink },
  meta: { fontSize: 11, fontWeight: "600", color: sky.muted, marginTop: 2 },
  err: { color: sky.bad, fontWeight: "700", marginBottom: 8, fontSize: 12 },
});
