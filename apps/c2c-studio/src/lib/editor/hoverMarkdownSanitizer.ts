"use client";

// Studio-IDE-9 (#254) / ADR 0005 Decision 5: hover-markdown sanitizer.
//
// Every Monaco hover surface in the studio routes its content through
// this module. The acceptance criterion "injecting <script> into a
// hypothetical hover content does not execute" is enforced by three
// independent gates:
//
//   1. `escapeMarkdownContent` HTML-escapes `&`, `<`, `>` so any
//      injected angle brackets are emitted as literal text instead of
//      being parsed as HTML tags.
//   2. `buildHoverMarkdown` materialises a Monaco `IMarkdownString`
//      with `supportHtml: false` so the renderer never interprets raw
//      HTML even if escaping is bypassed.
//   3. `isTrusted: false` on the same `IMarkdownString` instructs
//      Monaco to drop `command:` URIs so a crafted markdown link cannot
//      invoke a registered command.
//
// The full DOMPurify pipeline described in ADR 0005 Decision 5 applies
// to hover sources that ingest untrusted markdown (LLM output, BFF
// passthrough). The hover provider shipped by Studio-IDE-9 emits only
// static, code-controlled strings from cobolKnowledge.ts, so the
// renderer's `supportHtml: false` plus this escape function is the
// load-bearing gate. Future hover surfaces that consume untrusted input
// must extend this module with a markdown renderer + DOMPurify stage
// rather than relaxing the current contract.

import type * as MonacoNs from "monaco-editor";

// Escape table applied left-to-right. `&` must come first because the
// replacement strings contain `&` themselves; reversing the order would
// produce `&amp;lt;` for an input `<`.
const HTML_ESCAPE_TABLE: ReadonlyArray<readonly [string, string]> = [
  ["&", "&amp;"],
  ["<", "&lt;"],
  [">", "&gt;"],
];

export function escapeMarkdownContent(value: string): string {
  let escaped = value;
  for (const [char, entity] of HTML_ESCAPE_TABLE) {
    escaped = escaped.split(char).join(entity);
  }
  return escaped;
}

// Allow-list of href schemes accepted by hover markdown links. Mirrors
// the ADR 0005 Decision 5 allow-list (relative anchors and relative
// paths). `javascript:`, `data:`, `vbscript:`, `mailto:`, and absolute
// `http(s)://` URIs are rejected — callers that need a different scheme
// must extend this list deliberately rather than by widening here.
const SAFE_HREF_PATTERNS: readonly RegExp[] = [
  /^#[A-Za-z0-9_.-]+$/,
  /^\.\/[A-Za-z0-9_./-]+$/,
  /^\.\.\/[A-Za-z0-9_./-]+$/,
] as const;

export function isSafeHref(href: string): boolean {
  return SAFE_HREF_PATTERNS.some((pattern) => pattern.test(href));
}

// Build an `IMarkdownString` with the hardened defaults this module
// promises: `isTrusted: false`, `supportHtml: false`. Callers are
// responsible for escaping any dynamic fragments inside `value` via
// `escapeMarkdownContent`; this helper does not re-scan the string
// because doing so would corrupt legitimate markdown syntax such as
// code spans and emphasis runs.
export function buildHoverMarkdown(value: string): MonacoNs.IMarkdownString {
  return {
    value,
    isTrusted: false,
    supportHtml: false,
  };
}
