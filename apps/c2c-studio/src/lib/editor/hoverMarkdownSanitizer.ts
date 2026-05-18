"use client";

// Studio-IDE-9 (#254) — stage 1 of the ADR 0005 Decision 5 two-stage
// pipeline. Studio-IDE-10 (#249) — stage 2 (DOMPurify + markdown
// renderer with HTML pass-through disabled).
//
// Stage 1 covers the deterministic cobolKnowledge.ts hover provider,
// which emits hand-curated static strings. Stage 2 covers untrusted
// markdown sources — the Editor-Assist channel's model output, future
// LLM-backed hovers, and evidence-pack lineage tooltips. Stage 2 was
// deferred from PR #274 because no untrusted input existed yet; the
// Slice 10 work landing here is the documented natural place for it
// (see the original Studio-IDE-9 docblock for the contract).
//
// **Stage 1 — sanitisation for static markdown** (unchanged):
//   - `escapeMarkdownContent` HTML-escapes `&`, `<`, `>` so dynamic
//     fragments cannot smuggle tags through the static template.
//   - `buildHoverMarkdown` returns `IMarkdownString` with
//     `isTrusted: false`, `supportHtml: false`. The renderer treats
//     the input as plain markdown with no HTML pass-through.
//
// **Stage 2 — sanitisation for untrusted markdown** (this slice):
//   - `renderSanitizedHtml(rawMarkdown)` runs the full pipeline:
//        marked (HTML pass-through OFF) → DOMPurify (closed allow-list
//        from ADR 0005 §5) → string of allowlisted HTML.
//   - `buildSanitizedHoverMarkdown(rawMarkdown)` wraps the HTML in an
//     `IMarkdownString` with `isTrusted: false` and `supportHtml: true`.
//     `supportHtml: true` is safe here because the markup has already
//     been reduced to the allow-list; DOMPurify is the load-bearing
//     gate, not Monaco's own HTML refusal.
//   - The href scheme allow-list from ADR 0005 §5 is enforced via the
//     `ALLOWED_URI_REGEXP` option plus an `afterSanitizeAttributes`
//     hook that forces `rel="noopener noreferrer"` on `target="_blank"`
//     anchors.
//
// Callers MUST NOT route raw model output through React's
// `dangerouslySetInnerHTML` directly; the only sanctioned bridge is
// `renderSanitizedHtml` (or `buildSanitizedHoverMarkdown` for Monaco
// surfaces).

import DOMPurify from "dompurify";
import { marked } from "marked";
import type * as MonacoNs from "monaco-editor";

// ----- Stage 1 ------------------------------------------------------------

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

export function buildHoverMarkdown(value: string): MonacoNs.IMarkdownString {
  return {
    value,
    isTrusted: false,
    supportHtml: false,
  };
}

// ----- Stage 2 ------------------------------------------------------------

// DOMPurify allow-list mirrors the ADR 0005 §5 table verbatim. Any
// addition requires a co-ordinated ADR update plus new tests in
// `hoverMarkdownSanitizer.test.ts`.
//
// h2–h6 are included so the rendered explanation can carry document
// structure (WCAG 1.3.1 — info and relationships must survive). h1 is
// intentionally omitted: the panel header is the page-level landmark;
// allowing h1 in body content would create a duplicate page title.
const ALLOWED_TAGS: readonly string[] = [
  "p",
  "br",
  "strong",
  "em",
  "code",
  "pre",
  "a",
  "ul",
  "ol",
  "li",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
] as const;

const ALLOWED_ATTR: readonly string[] = ["href", "target", "rel"] as const;

// `ALLOWED_URI_REGEXP` is consulted by DOMPurify to filter URI-bearing
// attributes (notably `href`, `src`). The pattern accepts only the
// schemes listed in ADR 0005 §5 — relative anchors and relative paths.
// Absolute https URIs are out of scope for the deployment-configured
// prefix in this slice (no production deployment surface yet); future
// callers extend by passing through a wrapper that validates the
// prefix before calling `renderSanitizedHtml`.
//
// The pattern intentionally rejects bare colons in unanchored prefixes
// (e.g. `javascript:`, `data:`) by requiring the leading character to
// be `#`, `.`, or `/`.
const ALLOWED_URI_REGEXP = /^(?:#[A-Za-z0-9_.-]+|\.\.?\/[A-Za-z0-9_./-]+)$/;

let purifyHookInstalled = false;

function installPurifyHooksOnce(): void {
  if (purifyHookInstalled) {
    return;
  }
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (!(node instanceof Element)) {
      return;
    }
    // Force `rel="noopener noreferrer"` whenever a sanctioned link
    // opens a new tab. We cannot rely on the source markdown carrying
    // it because the markdown renderer does not synthesise `rel`.
    if (node.tagName === "A") {
      const target = node.getAttribute("target");
      if (target === "_blank") {
        node.setAttribute("rel", "noopener noreferrer");
      }
      // Defensive double-check on the href scheme: DOMPurify already
      // strips disallowed schemes via ALLOWED_URI_REGEXP, but a future
      // browser-side parser quirk should not become a bypass. Drop
      // any anchor whose href did not survive the allow-list.
      const href = node.getAttribute("href");
      if (href !== null && !ALLOWED_URI_REGEXP.test(href)) {
        node.removeAttribute("href");
      }
    }
  });
  purifyHookInstalled = true;
}

function renderMarkdownToHtml(rawMarkdown: string): string {
  // marked v14: pin {async: false, breaks: false, gfm: true} explicitly;
  // HTML passthrough is escaped by the renderer's default — DOMPurify is
  // the load-bearing sanitization stage. Do not rely on a marked option
  // named `html` (deprecated/removed in v14; adding it will not compile).
  const html = marked.parse(rawMarkdown, {
    async: false,
    breaks: false,
    gfm: true,
  });
  // ``marked.parse`` returns ``string`` when called with
  // ``async: false`` — narrow the TypeScript type here.
  if (typeof html !== "string") {
    throw new Error("marked.parse returned a non-string in synchronous mode.");
  }
  return html;
}

export function renderSanitizedHtml(rawMarkdown: string): string {
  installPurifyHooksOnce();
  const renderedHtml = renderMarkdownToHtml(rawMarkdown);
  // The allow-list is explicit; we deliberately do NOT pass
  // ``USE_PROFILES: { html: true }`` because that merges in a broad
  // tag set that includes headings, tables, and other elements
  // outside the ADR 0005 §5 contract.
  const sanitised = DOMPurify.sanitize(renderedHtml, {
    ALLOWED_TAGS: [...ALLOWED_TAGS],
    ALLOWED_ATTR: [...ALLOWED_ATTR],
    ALLOWED_URI_REGEXP,
    FORBID_TAGS: ["script", "style", "iframe", "object", "embed"],
    FORBID_ATTR: ["onerror", "onclick", "onload", "style", "srcdoc", "srcset"],
    ALLOW_DATA_ATTR: false,
    RETURN_TRUSTED_TYPE: false,
  }) as string;
  return sanitised;
}

export function buildSanitizedHoverMarkdown(
  rawMarkdown: string,
): MonacoNs.IMarkdownString {
  const html = renderSanitizedHtml(rawMarkdown);
  return {
    value: html,
    isTrusted: false,
    supportHtml: true,
  };
}
