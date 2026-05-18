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
import { emit as emitTelemetry } from "./editorTelemetry";
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
import type { HoverConstructKind } from "@/types/editor-telemetry";

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
  // Studio-IDE-11 (#251): closed-enum tag describing which COBOL
  // construct produced this hover. Used to populate the
  // `hover.opened` / `hover.expanded` editor-telemetry payloads.
  constructKind: HoverConstructKind;
}

// Regex set, evaluated in priority order. Each entry matches a
// construct inside a single line. The matched span (start, end) is
// returned so the hover range highlights the relevant text and so the
// position-under-cursor test can ignore matches that the cursor does
// not actually land on.
interface TaggedMatch {
  start: number;
  end: number;
  entry: HoverEntry;
  constructKind: HoverConstructKind;
}

type LineMatcher = (line: string) => TaggedMatch[];

function collectMatches(
  line: string,
  ...matchers: LineMatcher[]
): TaggedMatch[] {
  const results: TaggedMatch[] = [];
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
  constructKind: HoverConstructKind,
  toEntry: (match: RegExpExecArray) => HoverEntry | null,
): TaggedMatch[] {
  const flagged = regex.flags.includes("g")
    ? regex
    : new RegExp(regex.source, `${regex.flags}g`);
  const matches: TaggedMatch[] = [];
  let match: RegExpExecArray | null;
  while ((match = flagged.exec(line)) !== null) {
    const entry = toEntry(match);
    if (entry) {
      const start = match.index + 1;
      const end = start + match[0].length;
      matches.push({ start, end, entry, constructKind });
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
function matchPicture(line: string): TaggedMatch[] {
  return matchAll(
    line,
    /\b(?:PIC|PICTURE)(?:\s+IS)?\s+([X9AVSPZ$+\-,/*B().0-9]+)/i,
    "pic",
    (match) => (match[1] ? explainPicture(match[1]) : null),
  );
}

// Packed-decimal USAGE forms map to the dedicated ``comp3`` telemetry
// bucket; everything else (COMP, COMP-1, COMP-2, COMP-4, COMP-5,
// BINARY, POINTER, INDEX, DISPLAY-as-USAGE) maps to the generic
// ``usage`` bucket so the analyzer can distinguish packed-decimal data
// layouts from other USAGE families.
function usageKindFor(operand: string): "comp3" | "usage" {
  const normalized = operand.toUpperCase();
  if (normalized === "COMP-3" || normalized === "PACKED-DECIMAL") {
    return "comp3";
  }
  return "usage";
}

function matchUsage(line: string): TaggedMatch[] {
  const regex =
    /\b(?:USAGE\s+(?:IS\s+)?)?(COMP-[1-5]|COMP|PACKED-DECIMAL|BINARY|POINTER|INDEX|DISPLAY)\b/i;
  const flagged = regex.flags.includes("g")
    ? regex
    : new RegExp(regex.source, `${regex.flags}g`);
  const matches: TaggedMatch[] = [];
  let match: RegExpExecArray | null;
  while ((match = flagged.exec(line)) !== null) {
    const operand = match[1] ?? "";
    // Filter out the bare ``DISPLAY`` verb (operand not in a USAGE
    // clause). Only accept DISPLAY when the captured match itself
    // includes the ``USAGE`` prefix.
    if (operand.toUpperCase() === "DISPLAY" && !/^USAGE\b/i.test(match[0])) {
      if (match.index === flagged.lastIndex) flagged.lastIndex += 1;
      continue;
    }
    const entry = operand ? explainUsage(operand) : null;
    if (entry) {
      const start = match.index + 1;
      const end = start + match[0].length;
      matches.push({
        start,
        end,
        entry,
        constructKind: usageKindFor(operand),
      });
    }
    if (match.index === flagged.lastIndex) flagged.lastIndex += 1;
  }
  return matches;
}

function matchOccurs(line: string): TaggedMatch[] {
  return matchAll(
    line,
    /\bOCCURS\s+\d+(?:\s+TO\s+\d+)?\s+TIMES?(?:\s+DEPENDING\s+ON\s+[A-Za-z][A-Za-z0-9-]*)?/i,
    "occurs",
    (match) => explainOccurs(match[0]),
  );
}

function matchValue(line: string): TaggedMatch[] {
  return matchAll(
    line,
    /\bVALUES?(?:\s+IS)?\s+(?:['"][^'"]*['"]|[+-]?\d+(?:\.\d+)?|ZEROS?|ZEROES|SPACES?|HIGH-VALUES?|LOW-VALUES?|QUOTES?)/i,
    "value",
    (match) => explainValue(match[0]),
  );
}

function matchRedefines(line: string): TaggedMatch[] {
  return matchAll(
    line,
    /\bREDEFINES\s+[A-Za-z][A-Za-z0-9-]*/i,
    "redefines",
    (match) => explainRedefines(match[0]),
  );
}

function matchSection(line: string): TaggedMatch[] {
  const entry = explainSection(line);
  if (!entry) return [];
  const sectionMatch = /([A-Za-z][A-Za-z0-9-]*)\s+SECTION\s*\./i.exec(line);
  if (!sectionMatch) return [];
  const start = sectionMatch.index + 1;
  const end = start + sectionMatch[0].length;
  return [{ start, end, entry, constructKind: "section" }];
}

function matchParagraph(line: string): TaggedMatch[] {
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
      constructKind: "paragraph",
    },
  ];
}

// Find the best match for the cursor position. Returns the *most
// specific* match that overlaps the cursor (smallest span) so an
// OCCURS clause inside a PIC line doesn't lose its hover to a broader
// keyword match.
function pickBestMatch(
  matches: TaggedMatch[],
  column: number,
): TaggedMatch | null {
  // `end` is exclusive (start + match[0].length), so the strict `<`
  // here matches Monaco's range convention and avoids returning a
  // hover for the column immediately after the matched span.
  const overlapping = matches.filter(
    (m) => column >= m.start && column < m.end,
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
      constructKind: best.constructKind,
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
    constructKind: "fixed-format-zone",
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
  _monaco: typeof MonacoNs,
  computed: ComputedHover,
  lineNumber: number,
): MonacoNs.languages.Hover {
  // `_monaco` is currently unused but kept on the public signature so
  // future Monaco-specific shaping (e.g. theme-aware code-fence
  // language tags) can read from the instance without breaking callers.
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
      // Studio-IDE-11 (#251): emit closed-enum hover telemetry. The
      // payload carries only the construct family — never the source
      // text, column, or line content.
      emitTelemetry({
        eventType: "hover.opened",
        payload: { constructKind: computed.constructKind },
      });
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
