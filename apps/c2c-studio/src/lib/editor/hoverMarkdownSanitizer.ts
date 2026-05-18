"use client";

// Studio-IDE-9 (#254): hover-markdown sanitizer — scoped stage-1 of
// the ADR 0005 Decision 5 two-stage pipeline.
//
// **Scope of this module (PR #274 / Issue #254).** The hover provider
// shipped by Studio-IDE-9 emits *only* static, code-controlled strings
// from cobolKnowledge.ts. No runtime input — neither user-typed COBOL
// nor BFF-proxied data — flows through `buildHoverMarkdown` in this
// PR. For that closed-set surface, the acceptance criterion "injecting
// <script> into a hypothetical hover content does not execute" is
// enforced by three independent gates:
//
//   1. `escapeMarkdownContent` HTML-escapes `&`, `<`, `>` so any
//      angle brackets that *do* appear in dynamic name fragments
//      (escaped at call sites in cobolKnowledge.ts) emit as literal
//      text instead of being parsed as HTML tags.
//   2. `buildHoverMarkdown` materialises a Monaco `IMarkdownString`
//      with `supportHtml: false` so the renderer never interprets raw
//      HTML even if escaping is bypassed.
//   3. `isTrusted: false` on the same `IMarkdownString` instructs
//      Monaco to drop `command:` URIs so a crafted markdown link cannot
//      invoke a registered command.
//
// **Stage 2 (DOMPurify) is intentionally NOT shipped in this PR.** ADR
// 0005 Decision 5 prescribes the full two-stage pipeline for hover
// surfaces that ingest untrusted markdown (Slice 10 model-gateway
// passthrough, evidence-pack lineage, future LLM-assisted hovers).
// The deterministic Studio-IDE-9 knowledge layer does not produce
// such input — every `HoverEntry.explanation` / `javaMapping` /
// `warning` field is a literal in cobolKnowledge.ts authored by hand.
// Installing DOMPurify and a markdown renderer purely to satisfy the
// declarative contract for static content would add dead code with no
// load-bearing role.
//
// **Contract for future hover surfaces.** Any caller that intends to
// route runtime-derived markdown through `buildHoverMarkdown` MUST
// first land the missing stage-2 work: install DOMPurify, add a
// markdown→HTML renderer with HTML pass-through disabled, and update
// this module to expose a `buildSanitizedHoverMarkdown(rawMarkdown)`
// entry point that runs the full pipeline. The existing
// `buildHoverMarkdown` export remains valid for hand-curated static
// content only. The Slice 10 work that introduces untrusted hover
// input is the natural place to land stage 2 — at that point this
// docblock is the spec to satisfy.

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
