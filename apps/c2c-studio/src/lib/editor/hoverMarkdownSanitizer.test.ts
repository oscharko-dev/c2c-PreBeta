import { describe, expect, it } from "vitest";

import {
  buildHoverMarkdown,
  escapeMarkdownContent,
  isSafeHref,
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
