import { useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { useAuth } from "@/lib/AuthContext";
import { sky } from "@/lib/theme";
import { Btn, Field, Sheet } from "@/components/ui";

export default function LoginScreen() {
  const { signIn, magicLink } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"password" | "magic">("password");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      if (mode === "magic") {
        await magicLink(email);
        setMsg("Check your email for a sign-in link.");
      } else {
        await signIn(email, password);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Sign-in failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={{ flex: 1 }}>
      <LinearGradient
        colors={[sky.top, sky.mid, sky.horizon]}
        style={StyleSheet.absoluteFill}
      />
      <KeyboardAvoidingView
        style={styles.wrap}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View style={styles.logo} />
        <Text style={styles.title}>Array Operator</Text>
        <Text style={styles.sub}>React Native · sky fleet · offtakers</Text>

        <Sheet style={{ marginTop: 24 }}>
          <Field
            label="Email"
            value={email}
            onChangeText={setEmail}
            keyboardType="email-address"
          />
          {mode === "password" ? (
            <Field
              label="Password"
              value={password}
              onChangeText={setPassword}
              secure
            />
          ) : null}
          <Btn
            title={
              busy
                ? "Working…"
                : mode === "password"
                  ? "Sign in"
                  : "Email me a link"
            }
            primary
            onPress={submit}
            disabled={busy}
          />
          <View style={{ height: 10 }} />
          <Btn
            title={
              mode === "password" ? "Use magic link instead" : "Use password instead"
            }
            onPress={() =>
              setMode((m) => (m === "password" ? "magic" : "password"))
            }
          />
          {msg ? <Text style={styles.ok}>{msg}</Text> : null}
          {err ? <Text style={styles.err}>{err}</Text> : null}
        </Sheet>
        <Text style={styles.foot}>Same account as arrayoperator.com</Text>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: 22,
  },
  logo: {
    alignSelf: "center",
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: sky.primary,
    borderWidth: 3,
    borderColor: "rgba(255,255,255,0.6)",
    marginBottom: 14,
  },
  title: {
    textAlign: "center",
    fontSize: 26,
    fontWeight: "800",
    color: "#fff",
  },
  sub: {
    textAlign: "center",
    marginTop: 6,
    fontSize: 13,
    fontWeight: "600",
    color: "rgba(255,255,255,0.9)",
  },
  ok: {
    marginTop: 12,
    textAlign: "center",
    color: "#15803d",
    fontWeight: "700",
    fontSize: 12,
  },
  err: {
    marginTop: 12,
    textAlign: "center",
    color: sky.bad,
    fontWeight: "700",
    fontSize: 12,
  },
  foot: {
    marginTop: 18,
    textAlign: "center",
    color: "rgba(255,255,255,0.85)",
    fontSize: 11,
    fontWeight: "600",
  },
});
