import React from "react";
import { StyleSheet, Text, TextStyle, View } from "react-native";
import { sky } from "@/lib/theme";

/** Minimal **bold** / *italic* / line-break formatter for agent replies. */
export function FormattedText({
  text,
  style,
  user,
}: {
  text: string;
  style?: TextStyle;
  user?: boolean;
}) {
  const paragraphs = (text || "").replace(/\r\n/g, "\n").split(/\n{2,}/);
  return (
    <View style={{ gap: 8 }}>
      {paragraphs.map((para, pi) => {
        const lines = para.split("\n");
        return (
          <View key={pi} style={{ gap: 4 }}>
            {lines.map((line, li) => {
              const bullet = line.match(/^[-*•]\s+(.*)$/);
              const content = bullet ? bullet[1] : line;
              return (
                <Text
                  key={li}
                  style={[
                    styles.base,
                    user && styles.user,
                    style,
                    bullet && { paddingLeft: 4 },
                  ]}
                >
                  {bullet ? "• " : ""}
                  {renderInline(content, user)}
                </Text>
              );
            })}
          </View>
        );
      })}
    </View>
  );
}

function renderInline(raw: string, user?: boolean): React.ReactNode[] {
  const re = /(\*\*\*[^*]+\*\*\*|\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;
  const out: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(raw)) !== null) {
    if (m.index > last) out.push(raw.slice(last, m.index));
    const tok = m[0];
    const k = i++;
    if (tok.startsWith("***")) {
      out.push(
        <Text key={k} style={[styles.bold, styles.italic, user && styles.user]}>
          {tok.slice(3, -3)}
        </Text>
      );
    } else if (tok.startsWith("**")) {
      out.push(
        <Text key={k} style={[styles.bold, user && styles.user]}>
          {tok.slice(2, -2)}
        </Text>
      );
    } else if (tok.startsWith("*")) {
      out.push(
        <Text key={k} style={[styles.italic, user && styles.user]}>
          {tok.slice(1, -1)}
        </Text>
      );
    } else if (tok.startsWith("`")) {
      out.push(
        <Text key={k} style={styles.code}>
          {tok.slice(1, -1)}
        </Text>
      );
    }
    last = m.index + tok.length;
  }
  if (last < raw.length) out.push(raw.slice(last));
  return out;
}

const styles = StyleSheet.create({
  base: {
    fontSize: 14,
    fontWeight: "600",
    color: sky.ink,
    lineHeight: 21,
  },
  user: { color: "#fff" },
  bold: { fontWeight: "800" },
  italic: { fontStyle: "italic" },
  code: {
    fontFamily: "monospace",
    fontSize: 12,
    fontWeight: "700",
    backgroundColor: "rgba(33,150,243,0.12)",
    color: sky.primaryDeep,
  },
});
