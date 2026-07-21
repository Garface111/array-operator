import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  agentChat,
  agentConfirm,
  startAgentSession,
} from "@/lib/agentApi";
import { FormattedText } from "@/components/FormattedText";
import { sky } from "@/lib/theme";

type Msg = { role: "user" | "agent"; text: string; tools?: string[] };

type Props = {
  open: boolean;
  onClose: () => void;
  seedPrompt?: string | null;
};

export function AgentModal({ open, onClose, seedPrompt }: Props) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pending, setPending] = useState<{
    id?: string;
    reason?: string;
    tool?: string;
  } | null>(null);
  const seeded = useRef(false);
  const scrollRef = useRef<ScrollView>(null);

  useEffect(() => {
    if (!open) {
      seeded.current = false;
      setPending(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        setErr(null);
        const s = await startAgentSession({
          client: "owner-native",
          surface: "rn_agent",
        });
        if (cancelled) return;
        setSessionId(s.session_id || null);
        setMsgs([
          {
            role: "agent",
            text:
              s.intro ||
              "Hi — I'm Energy Agent on React Native. Fleet, offtakers, repairs, marketplace — ask me.",
          },
        ]);
      } catch (e) {
        if (!cancelled)
          setErr(e instanceof Error ? e.message : "Could not start Agent");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open || !seedPrompt || !sessionId || seeded.current || busy) return;
    seeded.current = true;
    void send(seedPrompt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, seedPrompt, sessionId]);

  async function send(text: string) {
    const t = text.trim();
    if (!t || busy) return;
    setInput("");
    setMsgs((m) => [...m, { role: "user", text: t }]);
    setBusy(true);
    setErr(null);
    setPending(null);
    try {
      let sid = sessionId;
      if (!sid) {
        const s = await startAgentSession();
        sid = s.session_id || null;
        setSessionId(sid);
      }
      if (!sid) throw new Error("No session");
      const res = await agentChat(sid, t);
      const reply = res.reply || res.speak || "Done.";
      const tools = (res.tool_trace || [])
        .map((x) => x.name || "")
        .filter(Boolean) as string[];
      setMsgs((m) => [
        ...m,
        { role: "agent", text: reply, tools: tools.length ? tools : undefined },
      ]);
      if (res.pending) setPending(res.pending);
      for (const c of res.ui_commands || []) {
        if (c.type === "open_url" && c.url) {
          try {
            await Linking.openURL(c.url);
          } catch {
            /* ignore */
          }
        }
      }
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 50);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Chat failed");
    } finally {
      setBusy(false);
    }
  }

  async function onConfirm(yes: boolean) {
    if (!sessionId || busy) return;
    setBusy(true);
    try {
      const res = await agentConfirm(sessionId, yes, pending?.id);
      setPending(null);
      const text = yes
        ? (res.result as { message?: string })?.message ||
          res.message ||
          "Done."
        : "Cancelled.";
      setMsgs((m) => [...m, { role: "agent", text: String(text) }]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Confirm failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal visible={open} animationType="slide" onRequestClose={onClose}>
      <View style={styles.root}>
        <View style={styles.header}>
          <Text style={styles.title}>Energy Agent</Text>
          <Pressable onPress={onClose} hitSlop={12}>
            <Text style={styles.close}>Close</Text>
          </Pressable>
        </View>
        <ScrollView
          ref={scrollRef}
          style={styles.list}
          contentContainerStyle={{ padding: 14, gap: 10 }}
        >
          {msgs.map((m, i) => (
            <View
              key={i}
              style={[
                styles.bubble,
                m.role === "user" ? styles.user : styles.agent,
              ]}
            >
              <FormattedText text={m.text} user={m.role === "user"} />
              {m.tools?.length ? (
                <Text style={styles.tools}>{m.tools.join(" · ")}</Text>
              ) : null}
            </View>
          ))}
          {pending ? (
            <View style={styles.pending}>
              <Text style={styles.pendingTitle}>Confirm action</Text>
              <Text style={styles.pendingBody}>
                {pending.reason || pending.tool || "Apply this change?"}
              </Text>
              <View style={styles.row}>
                <Pressable
                  style={[styles.btn, styles.btnYes]}
                  onPress={() => void onConfirm(true)}
                >
                  <Text style={styles.btnYesText}>Yes, do it</Text>
                </Pressable>
                <Pressable
                  style={[styles.btn, styles.btnNo]}
                  onPress={() => void onConfirm(false)}
                >
                  <Text style={styles.btnNoText}>Cancel</Text>
                </Pressable>
              </View>
            </View>
          ) : null}
          {busy ? <ActivityIndicator color={sky.primaryDeep} /> : null}
          {err ? <Text style={styles.err}>{err}</Text> : null}
        </ScrollView>
        <View style={styles.composer}>
          <TextInput
            value={input}
            onChangeText={setInput}
            placeholder="Ask anything on this account…"
            placeholderTextColor={sky.faint}
            style={styles.input}
            editable={!busy}
          />
          <Pressable
            style={[styles.send, (!input.trim() || busy) && { opacity: 0.5 }]}
            onPress={() => void send(input)}
            disabled={!input.trim() || busy}
          >
            <Text style={styles.sendText}>Send</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: sky.bg, paddingTop: 48 },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: sky.line,
  },
  title: { fontSize: 17, fontWeight: "800", color: sky.ink },
  close: { fontWeight: "800", color: sky.primaryDeep },
  list: { flex: 1 },
  bubble: {
    maxWidth: "92%",
    borderRadius: 18,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  user: { alignSelf: "flex-end", backgroundColor: sky.primary },
  agent: {
    alignSelf: "flex-start",
    backgroundColor: "rgba(255,255,255,0.9)",
    borderWidth: 1,
    borderColor: sky.line,
  },
  bubbleText: { fontSize: 14, fontWeight: "600", color: sky.ink, lineHeight: 20 },
  tools: {
    marginTop: 6,
    fontSize: 10,
    fontWeight: "700",
    color: sky.muted,
  },
  pending: {
    backgroundColor: "#FEF3C7",
    borderRadius: 16,
    padding: 12,
    borderWidth: 1,
    borderColor: "#FCD34D",
  },
  pendingTitle: { fontWeight: "800", color: "#92400E", fontSize: 12 },
  pendingBody: { marginTop: 4, fontWeight: "600", color: "#78350F", fontSize: 13 },
  row: { flexDirection: "row", gap: 8, marginTop: 10 },
  btn: {
    flex: 1,
    minHeight: 40,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  btnYes: { backgroundColor: sky.primary },
  btnYesText: { color: "#fff", fontWeight: "800" },
  btnNo: { backgroundColor: "#fff", borderWidth: 1, borderColor: sky.line },
  btnNoText: { color: sky.ink, fontWeight: "800" },
  err: { color: sky.bad, fontWeight: "700" },
  composer: {
    flexDirection: "row",
    gap: 8,
    padding: 12,
    borderTopWidth: 1,
    borderTopColor: sky.line,
    backgroundColor: "rgba(255,255,255,0.9)",
  },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: sky.line,
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    fontWeight: "600",
    color: sky.ink,
  },
  send: {
    backgroundColor: sky.primary,
    borderRadius: 14,
    paddingHorizontal: 16,
    justifyContent: "center",
  },
  sendText: { color: "#fff", fontWeight: "800" },
});
