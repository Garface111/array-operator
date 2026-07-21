import React, { createContext, useContext, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AgentModal } from "@/components/AgentModal";
import { sky } from "@/lib/theme";

type Ctx = {
  openAgent: (prompt?: string) => void;
};

const AgentCtx = createContext<Ctx | null>(null);

export function AgentProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [seed, setSeed] = useState<string | null>(null);
  const insets = useSafeAreaInsets();

  const value = useMemo(
    () => ({
      openAgent: (prompt?: string) => {
        setSeed(prompt || null);
        setOpen(true);
      },
    }),
    []
  );

  return (
    <AgentCtx.Provider value={value}>
      {children}
      {/* Bottom dock — easier than header-only access */}
      {!open ? (
        <View
          pointerEvents="box-none"
          style={[
            styles.dockWrap,
            { bottom: Math.max(insets.bottom, 8) + 58 },
          ]}
        >
          <Pressable
            onPress={() => {
              setSeed(null);
              setOpen(true);
            }}
            style={styles.dock}
          >
            <View style={styles.grip} />
            <View style={styles.orb} />
            <View style={{ flex: 1 }}>
              <Text style={styles.dockTitle}>Energy Agent</Text>
              <Text style={styles.dockSub}>Tap to chat · fleet & offtakers</Text>
            </View>
            <View style={styles.chatPill}>
              <Text style={styles.chatPillText}>Chat</Text>
            </View>
          </Pressable>
        </View>
      ) : null}
      <AgentModal
        open={open}
        onClose={() => setOpen(false)}
        seedPrompt={seed}
      />
    </AgentCtx.Provider>
  );
}

export function useAgent(): Ctx {
  const v = useContext(AgentCtx);
  if (!v) throw new Error("useAgent outside AgentProvider");
  return v;
}

const styles = StyleSheet.create({
  dockWrap: {
    position: "absolute",
    left: 12,
    right: 12,
    zIndex: 50,
  },
  dock: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: "rgba(255,255,255,0.92)",
    borderRadius: 22,
    borderWidth: 1,
    borderColor: sky.line,
    paddingHorizontal: 12,
    paddingTop: 14,
    paddingBottom: 10,
    shadowColor: "#143C78",
    shadowOpacity: 0.12,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
  },
  grip: {
    width: 32,
    height: 4,
    borderRadius: 2,
    backgroundColor: "rgba(33,150,243,0.5)",
    position: "absolute",
    top: 7,
    left: "50%",
    marginLeft: -16,
  },
  orb: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: sky.primary,
  },
  dockTitle: {
    fontSize: 13,
    fontWeight: "800",
    color: sky.ink,
  },
  dockSub: { fontSize: 11, fontWeight: "600", color: sky.muted },
  chatPill: {
    backgroundColor: sky.primary,
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  chatPillText: { color: "#fff", fontWeight: "800", fontSize: 11 },
});
