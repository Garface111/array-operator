import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Btn, Card, Chip, H1, Loading, SkyScreen, Sub } from "@/components/ui";
import { useAuth } from "@/lib/AuthContext";
import { fetchAccount } from "@/lib/api";
import type { AccountInfo } from "@/lib/types";
import { sky } from "@/lib/theme";

const FEEDS = [
  {
    title: "Arrays / inverters",
    blurb: "SolarEdge, Locus, portal capture…",
  },
  {
    title: "Auto-refresh",
    blurb: "Cloud capture 24/7 without a browser tab.",
  },
  {
    title: "Utility bills",
    blurb: "GMP / SmartHub source of truth for invoices.",
  },
  {
    title: "Online pay",
    blurb: "Stripe Connect for offtaker pay links.",
  },
] as const;

export default function AccountScreen() {
  const { signOut } = useAuth();
  const [acct, setAcct] = useState<AccountInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetchAccount()
      .then(setAcct)
      .catch((e) => setErr(e instanceof Error ? e.message : "Load failed"))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <SkyScreen scroll={false}>
        <Loading />
      </SkyScreen>
    );
  }

  return (
    <SkyScreen>
      <H1>Account</H1>
      <Sub>Profile · feeds · sign out</Sub>
      {err ? <Text style={styles.err}>{err}</Text> : null}

      <Card style={{ marginBottom: 12 }}>
        <Text style={styles.label}>Signed in</Text>
        <Text style={styles.company}>
          {acct?.company_name || acct?.name || "—"}
        </Text>
        <Text style={styles.meta}>{acct?.email || "—"}</Text>
        <View style={styles.chips}>
          {acct?.product ? <Chip status={acct.product} /> : null}
          <Chip status={acct?.is_demo ? "demo" : "live"} />
          {acct?.subscription_status ? (
            <Chip status={String(acct.subscription_status)} />
          ) : null}
        </View>
      </Card>

      <Text style={styles.section}>Connect feeds</Text>
      <View style={{ gap: 8, marginBottom: 16 }}>
        {FEEDS.map((f) => (
          <Card key={f.title}>
            <Text style={styles.feedTitle}>{f.title}</Text>
            <Text style={styles.meta}>{f.blurb}</Text>
          </Card>
        ))}
      </View>

      <Btn title="Sign out" danger onPress={() => void signOut()} />
    </SkyScreen>
  );
}

const styles = StyleSheet.create({
  label: {
    fontSize: 10,
    fontWeight: "800",
    color: sky.primaryDeep,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  company: {
    marginTop: 6,
    fontSize: 17,
    fontWeight: "800",
    color: sky.ink,
  },
  meta: { fontSize: 13, fontWeight: "600", color: sky.muted, marginTop: 4 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 12 },
  section: {
    fontSize: 14,
    fontWeight: "800",
    color: sky.ink,
    marginBottom: 8,
  },
  feedTitle: { fontSize: 14, fontWeight: "800", color: sky.ink },
  err: { color: sky.bad, fontWeight: "700", marginBottom: 8, fontSize: 12 },
});
