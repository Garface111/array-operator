import React from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  ViewStyle,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import Svg, { Circle, Polyline } from "react-native-svg";
import { sky } from "@/lib/theme";
import { powerFrac, statusTone } from "@/lib/format";
import type { DailyPt } from "@/lib/types";

export function SkyScreen({
  children,
  scroll = true,
}: {
  children: React.ReactNode;
  scroll?: boolean;
}) {
  const body = scroll ? (
    <ScrollView
      contentContainerStyle={styles.scrollContent}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
    >
      {children}
    </ScrollView>
  ) : (
    <View style={styles.scrollContent}>{children}</View>
  );

  return (
    <View style={styles.root}>
      <LinearGradient
        colors={[sky.top, sky.mid, sky.horizon, sky.bg]}
        locations={[0, 0.28, 0.55, 1]}
        style={StyleSheet.absoluteFill}
      />
      {body}
    </View>
  );
}

export function Card({
  children,
  style,
  onPress,
}: {
  children: React.ReactNode;
  style?: ViewStyle;
  onPress?: () => void;
}) {
  if (onPress) {
    return (
      <Pressable
        onPress={onPress}
        style={({ pressed }) => [
          styles.card,
          style,
          pressed && { opacity: 0.92, transform: [{ scale: 0.99 }] },
        ]}
      >
        {children}
      </Pressable>
    );
  }
  return <View style={[styles.card, style]}>{children}</View>;
}

export function Sheet({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: ViewStyle;
}) {
  return <View style={[styles.sheet, style]}>{children}</View>;
}

export function H1({ children }: { children: React.ReactNode }) {
  return <Text style={styles.h1}>{children}</Text>;
}

export function Sub({ children }: { children: React.ReactNode }) {
  return <Text style={styles.sub}>{children}</Text>;
}

export function StatCard({
  label,
  value,
  meta,
}: {
  label: string;
  value: string;
  meta?: string;
}) {
  return (
    <Card style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statValue}>{value}</Text>
      {meta ? <Text style={styles.statMeta}>{meta}</Text> : null}
    </Card>
  );
}

export function Chip({ status }: { status?: string | null }) {
  const tone = statusTone(status);
  const bg =
    tone === "good"
      ? "rgba(34,197,94,0.14)"
      : tone === "warn"
        ? "rgba(245,158,11,0.16)"
        : tone === "bad"
          ? "rgba(239,68,68,0.14)"
          : "rgba(20,60,120,0.08)";
  const color =
    tone === "good"
      ? "#15803d"
      : tone === "warn"
        ? "#b45309"
        : tone === "bad"
          ? "#b91c1c"
          : sky.muted;
  return (
    <View style={[styles.chip, { backgroundColor: bg }]}>
      <Text style={[styles.chipText, { color }]}>{status || "—"}</Text>
    </View>
  );
}

export function Btn({
  title,
  onPress,
  primary,
  danger,
  disabled,
}: {
  title: string;
  onPress: () => void;
  primary?: boolean;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.btn,
        primary && styles.btnPrimary,
        !primary && styles.btnGhost,
        danger && { borderColor: sky.bad },
        disabled && { opacity: 0.5 },
        pressed && { opacity: 0.9 },
      ]}
    >
      <Text
        style={[
          styles.btnText,
          primary && { color: "#fff" },
          danger && { color: sky.bad },
        ]}
      >
        {title}
      </Text>
    </Pressable>
  );
}

export function Field({
  label,
  value,
  onChangeText,
  secure,
  autoCapitalize,
  keyboardType,
}: {
  label: string;
  value: string;
  onChangeText: (t: string) => void;
  secure?: boolean;
  autoCapitalize?: "none" | "sentences";
  keyboardType?: "email-address" | "default";
}) {
  return (
    <View style={{ marginBottom: 12 }}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        secureTextEntry={secure}
        autoCapitalize={autoCapitalize || "none"}
        keyboardType={keyboardType || "default"}
        autoCorrect={false}
        style={styles.input}
        placeholderTextColor={sky.faint}
      />
    </View>
  );
}

export function OutputGauge({
  powerW,
  nameplateKw,
  size = 52,
}: {
  powerW?: number | null;
  nameplateKw?: number | null;
  size?: number;
}) {
  const frac = powerFrac(powerW, nameplateKw);
  const pct = frac == null ? null : Math.round(frac * 100);
  const stroke = 6;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const filled = frac == null ? 0 : Math.min(1, frac) * c;
  const tone = frac == null ? "#94a3b8" : frac >= 0.15 ? sky.primary : "#94a3b8";
  return (
    <View style={{ width: size, height: size }}>
      <Svg width={size} height={size}>
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke="rgba(20,60,120,0.1)"
          strokeWidth={stroke}
          fill="none"
        />
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={tone}
          strokeWidth={stroke}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={`${filled} ${c - filled}`}
          rotation={-90}
          origin={`${size / 2}, ${size / 2}`}
        />
      </Svg>
      <View style={[StyleSheet.absoluteFill, styles.gaugeCenter]}>
        <Text style={styles.gaugeText}>{pct == null ? "—" : `${pct}%`}</Text>
      </View>
    </View>
  );
}

export function Sparkline({
  series,
  width = 100,
  height = 28,
}: {
  series?: DailyPt[] | null;
  width?: number;
  height?: number;
}) {
  const v = (series || [])
    .map((p) => Number(p?.kwh ?? 0))
    .filter((n) => Number.isFinite(n));
  if (v.length < 2) {
    return (
      <View style={{ width, height, justifyContent: "center" }}>
        <Text style={{ color: sky.faint, fontSize: 10, fontWeight: "700" }}>···</Text>
      </View>
    );
  }
  const max = Math.max(...v, 0.001);
  const min = Math.min(...v, 0);
  const span = Math.max(max - min, max * 0.08, 0.001);
  const step = width / (v.length - 1);
  const pts = v
    .map((n, i) => {
      const x = i * step;
      const y = height - 2 - ((n - min) / span) * (height - 4);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <Svg width={width} height={height}>
      <Polyline
        points={pts}
        fill="none"
        stroke={sky.primary}
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </Svg>
  );
}

export function PowerBar({
  powerW,
  nameplateKw,
  label,
}: {
  powerW?: number | null;
  nameplateKw?: number | null;
  label?: string;
}) {
  const frac = powerFrac(powerW, nameplateKw);
  const pct = frac == null ? 0 : Math.min(100, Math.round(frac * 100));
  return (
    <View>
      <View style={styles.barRow}>
        <Text style={styles.barLeft}>{label || "—"}</Text>
        <Text style={styles.barRight}>
          {frac == null ? "of max n/a" : `${pct}% of max`}
        </Text>
      </View>
      <View style={styles.barTrack}>
        <View
          style={[
            styles.barFill,
            { width: `${frac == null ? 0 : Math.min(100, frac * 100)}%` as `${number}%` },
          ]}
        />
      </View>
    </View>
  );
}

export function Loading() {
  return (
    <View style={styles.loading}>
      <ActivityIndicator color={sky.primaryDeep} />
      <Text style={styles.loadingText}>Loading…</Text>
    </View>
  );
}

export function Seg({
  options,
  value,
  onChange,
}: {
  options: { key: string; label: string }[];
  value: string;
  onChange: (k: string) => void;
}) {
  return (
    <View style={styles.seg}>
      {options.map((o) => {
        const on = o.key === value;
        return (
          <Pressable
            key={o.key}
            onPress={() => onChange(o.key)}
            style={[styles.segBtn, on && styles.segOn]}
          >
            <Text style={[styles.segText, on && styles.segTextOn]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  scrollContent: {
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 28,
  },
  card: {
    backgroundColor: sky.glass,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: sky.line,
    padding: 14,
    shadowColor: "#143C78",
    shadowOpacity: 0.08,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 2,
  },
  sheet: {
    backgroundColor: "rgba(255,255,255,0.72)",
    borderRadius: 28,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.55)",
    padding: 16,
  },
  h1: {
    fontSize: 22,
    fontWeight: "800",
    color: sky.ink,
    letterSpacing: -0.3,
  },
  sub: {
    fontSize: 13,
    fontWeight: "600",
    color: sky.muted,
    marginTop: 2,
    marginBottom: 12,
  },
  stat: { flex: 1, minWidth: "46%", padding: 12 },
  statLabel: {
    fontSize: 10,
    fontWeight: "800",
    color: sky.primaryDeep,
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  statValue: {
    marginTop: 4,
    fontSize: 16,
    fontWeight: "800",
    color: sky.ink,
  },
  statMeta: {
    marginTop: 3,
    fontSize: 11,
    fontWeight: "600",
    color: sky.muted,
  },
  chip: {
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  chipText: { fontSize: 11, fontWeight: "800" },
  btn: {
    minHeight: 46,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
  },
  btnPrimary: {
    backgroundColor: sky.primary,
    shadowColor: sky.primary,
    shadowOpacity: 0.35,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
  },
  btnGhost: {
    backgroundColor: "rgba(255,255,255,0.75)",
    borderWidth: 1,
    borderColor: sky.line,
  },
  btnText: { fontSize: 14, fontWeight: "800", color: sky.ink },
  fieldLabel: {
    fontSize: 12,
    fontWeight: "800",
    color: sky.muted,
    marginBottom: 6,
  },
  input: {
    borderWidth: 1,
    borderColor: sky.line,
    backgroundColor: "rgba(255,255,255,0.92)",
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    fontWeight: "600",
    color: sky.ink,
  },
  gaugeCenter: { alignItems: "center", justifyContent: "center" },
  gaugeText: { fontSize: 11, fontWeight: "800", color: sky.ink },
  barRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 4,
  },
  barLeft: { fontSize: 11, fontWeight: "800", color: sky.ink },
  barRight: { fontSize: 10, fontWeight: "700", color: sky.muted },
  barTrack: {
    height: 8,
    borderRadius: 999,
    backgroundColor: "rgba(20,60,120,0.1)",
    overflow: "hidden",
  },
  barFill: {
    height: "100%",
    borderRadius: 999,
    backgroundColor: sky.primary,
  },
  loading: {
    paddingVertical: 40,
    alignItems: "center",
    gap: 10,
  },
  loadingText: { fontWeight: "700", color: sky.muted },
  seg: {
    flexDirection: "row",
    backgroundColor: "rgba(255,255,255,0.45)",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: sky.line,
    padding: 4,
    gap: 4,
    marginBottom: 12,
  },
  segBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 12,
    alignItems: "center",
  },
  segOn: {
    backgroundColor: "rgba(255,255,255,0.95)",
  },
  segText: { fontSize: 12, fontWeight: "800", color: sky.muted },
  segTextOn: { color: sky.primaryDeep },
});
