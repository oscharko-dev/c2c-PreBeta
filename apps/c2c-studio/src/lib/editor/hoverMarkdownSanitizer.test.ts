import { describe, expect, it } from "vitest";

import {
  buildHoverMarkdown,
  buildSanitizedHoverMarkdown,
  escapeMarkdownContent,
  isSafeHref,
  renderSanitizedHtml,
} from "./hoverMarkdownSanitizer";

describe("escapeMarkdownContent", () => {
  it("escapes ampersand before angle brackets so escape sequences stay intact", () => {
    expect(escapeMarkdownContent("a & b")).toBe("a &amp; b");
    expect(escapeMarkdownContent("<a>")).toBe("&lt;a&gt;");
    expect(escapeMarkdownContent("&<")).toBe("&amp;&lt;");
  });

  it("neutralises a <script> payload (Studio-IDE-9 acceptance gate)", () => {
    const payload = "<script>alert(1)</script>";
    const escaped = escapeMarkdownContent(payload);
    expect(escaped).not.toContain("<script>");
    expect(escaped).toContain("&lt;script&gt;");
  });

  it("neutralises onerror-style HTML injection", () => {
    const payload = '<img src=x onerror="alert(1)">';
    const escaped = escapeMarkdownContent(payload);
    expect(escaped).not.toContain("<img");
    expect(escaped).toContain("&lt;img");
  });

  it("leaves plain text unchanged", () => {
    expect(escapeMarkdownContent("Numeric picture")).toBe("Numeric picture");
  });
});

describe("isSafeHref", () => {
  it("accepts relative anchors", () => {
    expect(isSafeHref("#data-dictionary")).toBe(true);
    expect(isSafeHref("#ws-counter")).toBe(true);
  });

  it("accepts relative paths", () => {
    expect(isSafeHref("./docs/cobol.md")).toBe(true);
    expect(isSafeHref("../shared/notes.md")).toBe(true);
  });

  it("rejects javascript: URIs", () => {
    expect(isSafeHref("javascript:alert(1)")).toBe(false);
  });

  it("rejects data: URIs", () => {
    expect(isSafeHref("data:text/html,<script>alert(1)</script>")).toBe(false);
  });

  it("rejects absolute http and https URIs", () => {
    expect(isSafeHref("http://example.com")).toBe(false);
    expect(isSafeHref("https://example.com")).toBe(false);
  });

  it("rejects command URIs", () => {
    expect(isSafeHref("command:c2c.open?foo")).toBe(false);
  });
});

describe("buildHoverMarkdown", () => {
  it("returns an IMarkdownString with hardened defaults", () => {
    const md = buildHoverMarkdown("# title\n\nbody");
    expect(md.value).toBe("# title\n\nbody");
    expect(md.isTrusted).toBe(false);
    expect(md.supportHtml).toBe(false);
  });

  it("does not silently mutate the caller's content", () => {
    const md = buildHoverMarkdown("a\nb");
    expect(md.value).toBe("a\nb");
  });
});

// Studio-IDE-10 (#249): stage 2 of the ADR 0005 §5 sanitizer pipeline.
// These tests cover the renderer + DOMPurify pass invoked by callers
// that ingest untrusted markdown (model-gateway explanation, future
// LLM hovers). Every payload in the ADR's E2E acceptance list is
// represented; a regression that lets one through is a security
// failure.

describe("renderSanitizedHtml — ADR 0005 §5 acceptance payloads", () => {
  it("neutralises <script>alert(1)</script>", () => {
    const html = renderSanitizedHtml("<script>alert(1)</script>");
    expect(html.toLowerCase()).not.toContain("<script");
    expect(html.toLowerCase()).not.toContain("alert(1)");
  });

  it("strips javascript: URIs from markdown links", () => {
    const html = renderSanitizedHtml("[x](javascript:alert(1))");
    expect(html.toLowerCase()).not.toContain("javascript:");
    expect(html.toLowerCase()).not.toContain("alert(1)");
  });

  it("strips data: URIs from markdown links", () => {
    const html = renderSanitizedHtml(
      "[x](data:text/html,<script>alert(1)</script>)",
    );
    expect(html.toLowerCase()).not.toContain("data:");
    expect(html.toLowerCase()).not.toContain("<script");
  });

  it("strips inline <img onerror=...> handlers", () => {
    const html = renderSanitizedHtml("<img src=x onerror=alert(1)>");
    expect(html.toLowerCase()).not.toContain("onerror");
    expect(html.toLowerCase()).not.toContain("alert(1)");
  });

  it("strips vbscript: URIs", () => {
    const html = renderSanitizedHtml("[x](vbscript:msgbox(1))");
    expect(html.toLowerCase()).not.toContain("vbscript:");
    expect(html.toLowerCase()).not.toContain("msgbox");
  });
});

describe("renderSanitizedHtml — href scheme allow-list", () => {
  it("preserves relative anchors", () => {
    const html = renderSanitizedHtml("[Anchor](#section-1)");
    expect(html).toContain('href="#section-1"');
  });

  it("preserves relative path links", () => {
    const html = renderSanitizedHtml("[Doc](./guide.md)");
    expect(html).toContain('href="./guide.md"');
  });

  it("preserves parent-path relative links", () => {
    const html = renderSanitizedHtml("[Doc](../shared/guide.md)");
    expect(html).toContain('href="../shared/guide.md"');
  });

  it("strips absolute http URIs not in the configured prefix", () => {
    const html = renderSanitizedHtml("[Link](http://attacker.example/)");
    expect(html.toLowerCase()).not.toContain("attacker.example");
  });

  it("strips mailto: URIs", () => {
    const html = renderSanitizedHtml("[Mail](mailto:a@b.example)");
    expect(html.toLowerCase()).not.toContain("mailto:");
  });
});

describe("renderSanitizedHtml — markdown emphasis preservation", () => {
  it("preserves **strong** emphasis", () => {
    const html = renderSanitizedHtml("This is **bold** text.");
    expect(html.toLowerCase()).toContain("<strong>bold</strong>");
  });

  it("preserves *em* emphasis", () => {
    const html = renderSanitizedHtml("This is *italic* text.");
    expect(html.toLowerCase()).toContain("<em>italic</em>");
  });

  it("preserves inline `code` spans", () => {
    const html = renderSanitizedHtml("Use `MOVE` here.");
    expect(html.toLowerCase()).toContain("<code>move</code>");
  });

  it("preserves fenced code blocks", () => {
    const html = renderSanitizedHtml("```\nMOVE 1 TO X.\n```");
    expect(html.toLowerCase()).toContain("<pre>");
    expect(html).toContain("MOVE 1 TO X.");
  });

  it("preserves unordered lists", () => {
    const html = renderSanitizedHtml("- item one\n- item two");
    expect(html.toLowerCase()).toContain("<ul>");
    expect(html.toLowerCase()).toContain("<li>item one</li>");
  });

  it("preserves ordered lists", () => {
    const html = renderSanitizedHtml("1. first\n2. second");
    expect(html.toLowerCase()).toContain("<ol>");
  });
});

describe("renderSanitizedHtml — disallowed elements", () => {
  it("strips <iframe>", () => {
    const html = renderSanitizedHtml("<iframe src='x'></iframe>");
    expect(html.toLowerCase()).not.toContain("<iframe");
  });

  it("strips <style>", () => {
    const html = renderSanitizedHtml("<style>body{}</style>");
    expect(html.toLowerCase()).not.toContain("<style");
  });

  it("strips <h1> headings — h1 is not in the allow-list (WCAG 1.3.1)", () => {
    const html = renderSanitizedHtml("# Heading");
    expect(html.toLowerCase()).not.toContain("<h1");
  });

  it("preserves ## H2 headings as <h2> (WCAG 1.3.1)", () => {
    const html = renderSanitizedHtml("## H2 heading");
    expect(html.toLowerCase()).toContain("<h2");
  });

  it("preserves ### H3 headings as <h3> (WCAG 1.3.1)", () => {
    const html = renderSanitizedHtml("### H3 heading");
    expect(html.toLowerCase()).toContain("<h3");
  });
});

describe("buildSanitizedHoverMarkdown", () => {
  it("returns an IMarkdownString carrying sanitized HTML and isTrusted:false", () => {
    const md = buildSanitizedHoverMarkdown("**bold**");
    expect(md.isTrusted).toBe(false);
    expect(md.supportHtml).toBe(true);
    expect(md.value.toLowerCase()).toContain("<strong>bold</strong>");
  });

  it("neutralises an injected <script> payload", () => {
    const md = buildSanitizedHoverMarkdown("<script>alert(1)</script>");
    expect(md.value.toLowerCase()).not.toContain("<script");
    expect(md.value.toLowerCase()).not.toContain("alert(1)");
  });
});
