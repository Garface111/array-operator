import type { ReactNode } from "react";

/**
 * Lightweight, safe-ish markdown for Energy Agent replies.
 * Supports: **bold**, *italic*, ***both***, `code`, [links](url),
 * headings (#–###), bullets (-/*), numbered lists, paragraphs, line breaks.
 * No raw HTML. No images. Escapes text outside formatting tokens.
 */

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Inline: bold / italic / code / links */
function inlineToNodes(raw: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  // Order matters: *** then ** then * then ` then [link]
  const re =
    /(\*\*\*[^*]+\*\*\*|\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(raw)) !== null) {
    if (m.index > last) {
      nodes.push(esc(raw.slice(last, m.index)));
    }
    const tok = m[0];
    const k = `${keyPrefix}-${i++}`;
    if (tok.startsWith("***") && tok.endsWith("***")) {
      nodes.push(
        <strong key={k} className="font-extrabold">
          <em>{tok.slice(3, -3)}</em>
        </strong>
      );
    } else if (tok.startsWith("**") && tok.endsWith("**")) {
      nodes.push(
        <strong key={k} className="font-extrabold text-ink">
          {tok.slice(2, -2)}
        </strong>
      );
    } else if (tok.startsWith("*") && tok.endsWith("*")) {
      nodes.push(
        <em key={k} className="italic text-ink/90">
          {tok.slice(1, -1)}
        </em>
      );
    } else if (tok.startsWith("`") && tok.endsWith("`")) {
      nodes.push(
        <code
          key={k}
          className="rounded-md bg-sky-100/80 px-1.5 py-0.5 font-mono text-[12px] font-semibold text-sky-900"
        >
          {tok.slice(1, -1)}
        </code>
      );
    } else if (tok.startsWith("[")) {
      const lm = tok.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (lm) {
        const href = lm[2].trim();
        const safe =
          href.startsWith("http://") ||
          href.startsWith("https://") ||
          href.startsWith("mailto:") ||
          href.startsWith("#");
        if (safe) {
          nodes.push(
            <a
              key={k}
              href={href}
              target={href.startsWith("http") ? "_blank" : undefined}
              rel="noopener noreferrer"
              className="font-bold text-sky-700 underline decoration-sky-300 underline-offset-2"
            >
              {lm[1]}
            </a>
          );
        } else {
          nodes.push(lm[1]);
        }
      } else {
        nodes.push(tok);
      }
    } else {
      nodes.push(tok);
    }
    last = m.index + tok.length;
  }
  if (last < raw.length) nodes.push(esc(raw.slice(last)));
  // react can render string arrays; wrap mixed
  return nodes.map((n, idx) =>
    typeof n === "string" ? (
      <span key={`${keyPrefix}-t-${idx}`} dangerouslySetInnerHTML={{ __html: n }} />
    ) : (
      n
    )
  );
}

type Block =
  | { type: "h"; level: 1 | 2 | 3; text: string }
  | { type: "p"; text: string }
  | { type: "ul"; items: string[] }
  | { type: "ol"; items: string[] }
  | { type: "hr" };

function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) {
      i += 1;
      continue;
    }
    if (/^---+$/.test(trimmed) || /^\*\*\*+$/.test(trimmed)) {
      blocks.push({ type: "hr" });
      i += 1;
      continue;
    }
    const hm = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (hm) {
      blocks.push({
        type: "h",
        level: hm[1].length as 1 | 2 | 3,
        text: hm[2],
      });
      i += 1;
      continue;
    }
    if (/^[-*•]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*•]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^[-*•]\s+/, ""));
        i += 1;
      }
      blocks.push({ type: "ul", items });
      continue;
    }
    if (/^\d+[.)]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+[.)]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^\d+[.)]\s+/, ""));
        i += 1;
      }
      blocks.push({ type: "ol", items });
      continue;
    }
    // paragraph: gather until blank
    const parts: string[] = [trimmed];
    i += 1;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^#{1,3}\s+/.test(lines[i].trim()) &&
      !/^[-*•]\s+/.test(lines[i].trim()) &&
      !/^\d+[.)]\s+/.test(lines[i].trim()) &&
      !/^---+$/.test(lines[i].trim())
    ) {
      parts.push(lines[i].trim());
      i += 1;
    }
    blocks.push({ type: "p", text: parts.join(" ") });
  }
  return blocks;
}

type Props = {
  text: string;
  /** User bubbles use lighter inline styles */
  variant?: "agent" | "user";
};

export function AgentMarkdown({ text, variant = "agent" }: Props) {
  const blocks = parseBlocks(text || "");
  if (!blocks.length) {
    return <span className="text-muted">…</span>;
  }

  const isUser = variant === "user";

  return (
    <div
      className={[
        "ao-md space-y-2.5 text-[13.5px] leading-[1.55]",
        isUser ? "text-white" : "text-ink",
      ].join(" ")}
    >
      {blocks.map((b, idx) => {
        const k = `b-${idx}`;
        if (b.type === "hr") {
          return (
            <hr
              key={k}
              className={
                isUser
                  ? "border-white/25"
                  : "border-sky-200/80"
              }
            />
          );
        }
        if (b.type === "h") {
          const cls =
            b.level === 1
              ? "text-[16px] font-extrabold tracking-tight"
              : b.level === 2
                ? "text-[15px] font-extrabold tracking-tight"
                : "text-[13.5px] font-extrabold tracking-tight";
          return (
            <div
              key={k}
              className={[
                cls,
                isUser ? "text-white" : "text-ink",
              ].join(" ")}
            >
              {inlineToNodes(b.text, k)}
            </div>
          );
        }
        if (b.type === "ul") {
          return (
            <ul
              key={k}
              className={[
                "my-0.5 list-disc space-y-1.5 pl-4",
                isUser ? "marker:text-white/70" : "marker:text-sky-500",
              ].join(" ")}
            >
              {b.items.map((it, j) => (
                <li key={`${k}-${j}`} className="pl-0.5">
                  {inlineToNodes(it, `${k}-${j}`)}
                </li>
              ))}
            </ul>
          );
        }
        if (b.type === "ol") {
          return (
            <ol
              key={k}
              className={[
                "my-0.5 list-decimal space-y-1.5 pl-4",
                isUser ? "marker:text-white/80" : "marker:text-sky-700 marker:font-bold",
              ].join(" ")}
            >
              {b.items.map((it, j) => (
                <li key={`${k}-${j}`} className="pl-0.5">
                  {inlineToNodes(it, `${k}-${j}`)}
                </li>
              ))}
            </ol>
          );
        }
        // paragraph
        return (
          <p key={k} className="m-0">
            {inlineToNodes(b.text, k)}
          </p>
        );
      })}
    </div>
  );
}
