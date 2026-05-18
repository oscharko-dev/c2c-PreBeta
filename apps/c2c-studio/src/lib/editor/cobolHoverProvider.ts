"use client";

// Studio-IDE-9 (#254): Monaco hover provider for COBOL.
//
// The provider is deterministic and local: every hover comes from the
// curated knowledge base in cobolKnowledge.ts. No network calls, no
// model invocation, no budget consumption. Slice 10 will introduce an
// AI-assisted fallback for dynamic context — until then the knowledge
// base is authoritative.
//
// All MarkdownString instances are constructed via
// `buildHoverMarkdown` so they share the hardened defaults
// (`isTrusted: false`, `supportHtml: false`) that satisfy the
// "<script> injection does not execute" acceptance gate.

import type * as MonacoNs from "monaco-editor";

import { COBOL_LANGUAGE_ID } from "./cobolMonarch";
import {
  buildHoverMarkdown,
  escapeMarkdownContent,
} from "./hoverMarkdownSanitizer";
import {
  explainFixedFormatZone,
  explainOccurs,
  explainParagraph,
  explainPicture,
  explainRedefines,
  explainSection,
  explainUsage,
  explainValue,
  hoverEntryToMarkdownString,
  type HoverEntry,
} from "./cobolKnowledge";

// ---------------------------------------------------------------------------
// Pure hover computation
// ---------------------------------------------------------------------------

// 1-based source position as Monaco reports it. Carries only the
// fields the provider reads — keeps the unit tests trivial to set up.
export interface HoverPosition {
  lineNumber: number;
  column: number;
}

// Result returned by `computeHoverFor` before it is converted into a
// Monaco `IHoverResult`. Splitting the pure computation from the
// Monaco-typed wrapper keeps the bulk of the logic testable without a
// real Monaco runtime.
export interface ComputedHover {
  entry: HoverEntry;
  // 1-based start column for the highlighted range.
  startColumn: number;
  // 1-based end column (exclusive) for the highlighted range.
  endColumn: number;
}

// Regex set, evaluated in priority order. Each entry matches a
// construct inside a single line. The matched span (start, end) is
// returned so the hover range highlights the relevant text and so the
// position-under-cursor test can ignore matches that the cursor does
// not actually land on.
type LineMatcher = (
  line: string,
) => Array<{ start: number; end: number; entry: HoverEntry }>;

function collectMatches(
  line: string,
  ...matchers: LineMatcher[]
): Array<{
  start: number;
  end: number;
  entry: HoverEntry;
}> {
  const results: Array<{ start: number; end: number; entry: HoverEntry }> = [];
  for (const matcher of matchers) {
    for (const match of matcher(line)) {
      results.push(match);
    }
  }
  return results;
}

function matchAll(
  line: string,
  regex: RegExp,
  toEntry: (match: RegExpExecArray) => HoverEntry | null,
): Array<{ start: number; end: number; entry: HoverEntry }> {
  const flagged = regex.flags.includes("g")
    ? regex
    : new RegExp(regex.source, `${regex.flags}g`);
  const matches: Array<{ start: number; end: number; entry: HoverEntry }> = [];
  let match: RegExpExecArray | null;
  while ((match = flagged.exec(line)) !== null) {
    const entry = toEntry(match);
    if (entry) {
      const start = match.index + 1;
      const end = start + match[0].length;
      matches.push({ start, end, entry });
    }
    if (match.index === flagged.lastIndex) {
      flagged.lastIndex += 1;
    }
  }
  return matches;
}

// Individual matchers, one per construct family. Each returns matches
// in the order they appear on the line so the picker can use cursor
// column to disambiguate.
function matchPicture(line: string) {
  return matchAll(
    line,
    /\b(?:PIC|PICTURE)(?:\s+IS)?\s+([X9AVSPZ$+\-,/*B().0-9]+)/i,
    (match) => (match[1] ? explainPicture(match[1]) : null),
  );
}

function matchUsage(line: string) {
  return matchAll(
    line,
    /\b(?:USAGE\s+(?:IS\s+)?)?(COMP-[1-5]|COMP|PACKED-DECIMAL|BINARY|POINTER|INDEX|DISPLAY)\b/i,
    (match) => {
      // Filter out the `DISPLAY` *verb* — only match it when it is the
      // operand of a USAGE clause. We approximate by requiring the
      // preceding token to be USAGE or a comma / newline. The simplest
      // safe form: only return a hover for DISPLAY when the keyword
      // USAGE precedes it on the line.
      if ((match[1] ?? "").toUpperCase() === "DISPLAY") {
        // Only accept DISPLAY as a USAGE-clause keyword when the
        // capturing match itself includes the `USAGE` prefix. A bare
        // DISPLAY on a procedural line is the verb, not a usage
        // qualifier, and must not surface a USAGE hover.
        if (!/^USAGE\b/i.test(match[0])) return null;
      }
      return match[1] ? explainUsage(match[1]) : null;
    },
  );
}

function matchOccurs(line: string) {
  return matchAll(
    line,
    /\bOCCURS\s+\d+(?:\s+TO\s+\d+)?\s+TIMES?(?:\s+DEPENDING\s+ON\s+[A-Za-z][A-Za-z0-9-]*)?/i,
    (match) => explainOccurs(match[0]),
  );
}

function matchValue(line: string) {
  return matchAll(
    line,
    /\bVALUE(?:S)?(?:\s+IS)?\s+(?:['"][^'"]*['"]|[+-]?\d+(?:\.\d+)?|ZEROS?|ZEROES|SPACES?|HIGH-VALUES?|LOW-VALUES?|QUOTES?)/i,
    (match) => explainValue(match[0]),
  );
}

function matchRedefines(line: string) {
  return matchAll(line, /\bREDEFINES\s+[A-Za-z][A-Za-z0-9-]*/i, (match) =>
    explainRedefines(match[0]),
  );
}

function matchSection(line: string) {
  const entry = explainSection(line);
  if (!entry) return [];
  const sectionMatch = /([A-Za-z][A-Za-z0-9-]*)\s+SECTION\s*\./i.exec(line);
  if (!sectionMatch) return [];
  const start = sectionMatch.index + 1;
  const end = start + sectionMatch[0].length;
  return [{ start, end, entry }];
}

function matchParagraph(line: string) {
  const entry = explainParagraph(line);
  if (!entry) return [];
  const paragraphMatch = /^\s*([A-Za-z][A-Za-z0-9-]*)\s*\.\s*$/.exec(line);
  if (!paragraphMatch || !paragraphMatch[1]) return [];
  const nameStart = line.indexOf(paragraphMatch[1]);
  if (nameStart < 0) return [];
  return [
    {
      start: nameStart + 1,
      end: nameStart + 1 + paragraphMatch[1].length,
      entry,
    },
  ];
}

// Find the best match for the cursor position. Returns the *most
// specific* match that overlaps the cursor (smallest span) so an
// OCCURS clause inside a PIC line doesn't lose its hover to a broader
// keyword match.
function pickBestMatch(
  matches: Array<{ start: number; end: number; entry: HoverEntry }>,
  column: number,
): { start: number; end: number; entry: HoverEntry } | null {
  const overlapping = matches.filter(
    (m) => column >= m.start && column <= m.end,
  );
  if (overlapping.length === 0) return null;
  overlapping.sort((a, b) => a.end - a.start - (b.end - b.start));
  return overlapping[0] ?? null;
}

export function computeHoverFor(
  line: string,
  position: HoverPosition,
): ComputedHover | null {
  const matches = collectMatches(
    line,
    matchPicture,
    matchUsage,
    matchOccurs,
    matchValue,
    matchRedefines,
    matchSection,
    matchParagraph,
  );
  const best = pickBestMatch(matches, position.column);
  if (best) {
    return {
      entry: best.entry,
      startColumn: best.start,
      endColumn: best.end,
    };
  }
  // No construct match — fall back to the fixed-format zone tooltip.
  // Determined from the cursor column alone; the zone tooltip covers
  // every column 1..80 so the hover always has *something* to show on
  // a fixed-format source.
  const zoneEntry = explainFixedFormatZone(position.column);
  if (!zoneEntry) return null;
  return {
    entry: zoneEntry,
    startColumn: position.column,
    endColumn: position.column + 1,
  };
}

// ---------------------------------------------------------------------------
// Monaco-bound provider
// ---------------------------------------------------------------------------

// Conversion to the Monaco contract is kept thin: we never call any
// Monaco API during the lookup so the unit tests don't need a Monaco
// instance. Only the wrapper that materialises the `IHoverResult`
// needs Monaco's types.

export function buildHoverResult(
  monaco: typeof MonacoNs,
  computed: ComputedHover,
  lineNumber: number,
): MonacoNs.languages.Hover {
  void monaco; // currently unused; reserved for future Monaco-specific shaping
  const markdown = hoverEntryToMarkdownString(computed.entry);
  const content = buildHoverMarkdown(markdown);
  return {
    contents: [content],
    range: {
      startLineNumber: lineNumber,
      endLineNumber: lineNumber,
      startColumn: computed.startColumn,
      endColumn: computed.endColumn,
    },
  };
}

export function createCobolHoverProvider(
  monaco: typeof MonacoNs,
): MonacoNs.languages.HoverProvider {
  return {
    provideHover(model, position) {
      const line = model.getLineContent(position.lineNumber);
      const computed = computeHoverFor(line, {
        lineNumber: position.lineNumber,
        column: position.column,
      });
      if (!computed) return null;
      return buildHoverResult(monaco, computed, position.lineNumber);
    },
  };
}

// Module-level guard so we never register the same provider twice
// against a shared Monaco instance — Monaco does not de-duplicate
// providers, and a stacked registration would render the hover twice
// for every match. Exposed for tests.
let registered = false;
let disposable: MonacoNs.IDisposable | null = null;

export function registerCobolHoverProvider(
  monaco: typeof MonacoNs,
): MonacoNs.IDisposable | null {
  if (registered) return disposable;
  disposable = monaco.languages.registerHoverProvider(
    COBOL_LANGUAGE_ID,
    createCobolHoverProvider(monaco),
  );
  registered = true;
  return disposable;
}

export function __resetCobolHoverProviderForTests(): void {
  registered = false;
  disposable?.dispose();
  disposable = null;
}

// Exported for use by the Data Dictionary panel — it needs to render
// the same explanation strings the hover provider uses, so the two
// surfaces never disagree on what a construct means.
export function entryToHoverMarkdownValue(entry: HoverEntry): string {
  return hoverEntryToMarkdownString(entry);
}

// Re-exported for callers that wrap raw user text into hover-safe
// markdown (e.g. the dictionary list rendering a non-COBOL caption).
export { escapeMarkdownContent };
