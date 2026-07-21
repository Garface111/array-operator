import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentMarkdown } from "./AgentMarkdown";

function html(text: string) {
  return renderToStaticMarkup(createElement(AgentMarkdown, { text }));
}

describe("AgentMarkdown", () => {
  it("renders bold and italic", () => {
    const h = html("Hello **world** and *fleet*");
    expect(h).toContain("<strong");
    expect(h).toContain("world");
    expect(h).toContain("<em");
    expect(h).toContain("fleet");
  });

  it("renders lists and headings", () => {
    const h = html("## Status\n\n- One\n- Two\n\nDone.");
    expect(h).toContain("Status");
    expect(h).toContain("<ul");
    expect(h).toContain("<li");
    expect(h).toContain("One");
  });

  it("escapes raw html", () => {
    const h = html("x <script>alert(1)</script> y");
    expect(h).not.toContain("<script>");
    expect(h).toContain("&lt;script&gt;");
  });
});
