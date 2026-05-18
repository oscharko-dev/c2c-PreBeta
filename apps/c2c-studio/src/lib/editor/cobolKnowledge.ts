"use client";

// Studio-IDE-9 (#254): deterministic, local knowledge base for COBOL
// hover content. No network calls, no model invocation, no budget
// consumption. The maps and helpers here are the single source of
// truth shared by the Monaco hover provider and the Data Dictionary
// side panel — keeping both surfaces in lock-step so a hover never
// disagrees with what the dictionary lists.

import { escapeMarkdownContent } from "./hoverMarkdownSanitizer";

// A structured hover description used by both the hover provider and
// the Data Dictionary panel. Callers convert this into a Monaco
// `IMarkdownString` via `hoverEntryToMarkdown`.
export interface HoverEntry {
  // Single-line headline.
  title: string;
  // 1-3 sentence explanation. May contain inline markdown but never
  // raw HTML — the sanitizer escapes content fragments at the caller.
  explanation: string;
  // Optional "this maps to ..." Java target summary.
  javaMapping?: string;
  // Optional cautionary note rendered as a markdown blockquote.
  warning?: string;
}

// ---------------------------------------------------------------------------
// PIC clause
// ---------------------------------------------------------------------------

export interface PictureShape {
  // The original picture string (e.g. "S9(5)V99").
  raw: string;
  // Integer-digit count for numeric pictures. `null` for non-numeric.
  integerDigits: number | null;
  // Digits after the implied decimal point. `null` for non-numeric.
  decimalDigits: number | null;
  // `S` flag present.
  signed: boolean;
  // Picture family.
  kind: "numeric" | "alphanumeric" | "alphabetic" | "mixed" | "unknown";
}

// Bounded count for `9(n)`-style repetition. The COBOL standard allows
// `n` up to 18 for numeric pictures; we cap at 1000 so a malformed
// source (or a deliberately abusive one) cannot drive the expansion
// loop unbounded. Picture strings that exceed the cap are still
// classified — they just collapse the repetition to the cap.
const PIC_COUNT_CAP = 1000;

// Parse a COBOL picture string into a structured shape. The parser is
// deliberately lenient: PICs we cannot interpret return
// `kind: "unknown"` rather than throw, so the hover surface always
// renders *some* explanation.
export function parsePicture(raw: string): PictureShape {
  const trimmed = raw.trim().toUpperCase();
  // Expand `9(5)` / `X(10)` style repetition into a flat character
  // sequence we can count. Bounded repetition guards against ReDoS
  // (the inner `\d{1,6}` cap defangs the count).
  const expanded = trimmed.replace(
    /([X9AVSPZ$+\-,/*B])\((\d{1,6})\)/g,
    (_, ch: string, n: string) => {
      const count = Math.min(Number(n), PIC_COUNT_CAP);
      return ch.repeat(count);
    },
  );
  const signed = expanded.includes("S");
  const hasV = expanded.includes("V");
  const hasX = /X/.test(expanded);
  const hasA = /A/.test(expanded);
  const numericChars = expanded.replace(/[^9V]/g, "");
  const totalDigits = (numericChars.match(/9/g) ?? []).length;
  const decimalDigits = hasV
    ? ((numericChars.split("V")[1] ?? "").match(/9/g)?.length ?? 0)
    : 0;
  const integerDigits = totalDigits - decimalDigits;
  let kind: PictureShape["kind"] = "unknown";
  if (totalDigits > 0 && !hasX && !hasA) {
    kind = "numeric";
  } else if (hasX && !hasA && totalDigits === 0) {
    kind = "alphanumeric";
  } else if (hasA && !hasX && totalDigits === 0) {
    kind = "alphabetic";
  } else if ((hasX || hasA) && totalDigits > 0) {
    kind = "mixed";
  }
  return {
    raw,
    integerDigits:
      kind === "numeric" || kind === "mixed" ? integerDigits : null,
    decimalDigits:
      kind === "numeric" || kind === "mixed" ? decimalDigits : null,
    signed,
    kind,
  };
}

function pluralise(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function alphanumericLength(raw: string): number {
  const expanded = raw
    .toUpperCase()
    .replace(/([X9AVSPZ$+\-,/*B])\((\d{1,6})\)/g, (_, ch: string, n: string) =>
      ch.repeat(Math.min(Number(n), PIC_COUNT_CAP)),
    );
  return expanded.replace(/[^XA]/gi, "").length;
}

export function explainPicture(raw: string): HoverEntry {
  const shape = parsePicture(raw);
  const safeRaw = escapeMarkdownContent(shape.raw);
  switch (shape.kind) {
    case "numeric": {
      const integer = shape.integerDigits ?? 0;
      const decimal = shape.decimalDigits ?? 0;
      const integerPhrase = pluralise(integer, "integer digit");
      const decimalPhrase =
        decimal > 0
          ? `, ${pluralise(decimal, "decimal digit")} (implied by \`V\`)`
          : "";
      const signedPhrase = shape.signed ? "signed" : "unsigned";
      const javaMapping =
        decimal > 0
          ? "Maps to **`java.math.BigDecimal`** so the implied decimal scale is preserved exactly."
          : integer > 18
            ? "Maps to **`java.math.BigInteger`** (precision exceeds `long`)."
            : integer > 9
              ? "Maps to **`long`**."
              : "Maps to **`int`**.";
      return {
        title: `PIC ${safeRaw}`,
        explanation: `Numeric picture: ${integerPhrase}${decimalPhrase}, ${signedPhrase}.`,
        javaMapping,
      };
    }
    case "alphanumeric": {
      const length = alphanumericLength(shape.raw);
      const lengthPhrase =
        length > 0 ? `Length ${length} byte${length === 1 ? "" : "s"}.` : "";
      return {
        title: `PIC ${safeRaw}`,
        explanation:
          `Alphanumeric picture (X). Holds any printable byte. ${lengthPhrase}`.trim(),
        javaMapping:
          "Maps to **`java.lang.String`** (fixed length on output, right-padded with spaces).",
      };
    }
    case "alphabetic": {
      const length = alphanumericLength(shape.raw);
      const lengthPhrase =
        length > 0
          ? `Length ${length} character${length === 1 ? "" : "s"}.`
          : "";
      return {
        title: `PIC ${safeRaw}`,
        explanation:
          `Alphabetic picture (A). Letters and spaces only. ${lengthPhrase}`.trim(),
        javaMapping:
          "Maps to **`java.lang.String`** with an alphabetic-only invariant.",
      };
    }
    case "mixed":
      return {
        title: `PIC ${safeRaw}`,
        explanation:
          "Mixed picture combining alphanumeric and numeric characters. Treated as a fixed-width string in storage; numeric semantics are intentionally not inferred.",
        javaMapping: "Maps to **`java.lang.String`**.",
      };
    case "unknown":
    default:
      return {
        title: `PIC ${safeRaw}`,
        explanation:
          "Picture clause. The shape could not be classified deterministically — open the Data Dictionary panel for the full source-level definition.",
      };
  }
}

// ---------------------------------------------------------------------------
// USAGE clause
// ---------------------------------------------------------------------------

const USAGE_ENTRIES: Record<string, HoverEntry> = {
  COMP: {
    title: "USAGE COMP",
    explanation:
      "Compiler-native binary integer storage (a.k.a. COMPUTATIONAL). Width derives from the companion PIC — typically 2, 4, or 8 bytes.",
    javaMapping: "Maps to **`int`** or **`long`** depending on the PIC scale.",
  },
  "COMP-1": {
    title: "USAGE COMP-1",
    explanation:
      "Single-precision binary floating point. No PIC clause is permitted.",
    javaMapping: "Maps to **`float`**.",
  },
  "COMP-2": {
    title: "USAGE COMP-2",
    explanation:
      "Double-precision binary floating point. No PIC clause is permitted.",
    javaMapping: "Maps to **`double`**.",
  },
  "COMP-3": {
    title: "USAGE COMP-3",
    explanation:
      "Packed decimal: two BCD digits per byte, sign nibble in the rightmost byte. Storage is `ceil((digits + 1) / 2)` bytes.",
    javaMapping:
      "Maps to **`java.math.BigDecimal`** for exact decimal arithmetic.",
  },
  "COMP-4": {
    title: "USAGE COMP-4",
    explanation:
      "Vendor-specific binary integer storage; semantics typically match COMP. Treat as binary integer unless the dialect dictates otherwise.",
    javaMapping: "Maps to **`int`** or **`long`** depending on the PIC scale.",
  },
  "COMP-5": {
    title: "USAGE COMP-5",
    explanation:
      "Native binary integer using the host machine's natural byte order. Width derives from the companion PIC.",
    javaMapping: "Maps to **`int`** or **`long`** depending on the PIC scale.",
  },
  DISPLAY: {
    title: "USAGE DISPLAY",
    explanation:
      "Default storage: each digit or character occupies one byte in display-character form (EBCDIC on z/OS, ASCII elsewhere).",
    javaMapping:
      "Maps to **`java.lang.String`** (numeric) or the PIC-derived numeric type after parsing.",
  },
  "PACKED-DECIMAL": {
    title: "USAGE PACKED-DECIMAL",
    explanation:
      "Synonym for COMP-3. Packed BCD storage with a sign nibble in the rightmost byte.",
    javaMapping: "Maps to **`java.math.BigDecimal`**.",
  },
  BINARY: {
    title: "USAGE BINARY",
    explanation:
      "Binary integer storage in network byte order; width derives from the PIC scale (2, 4, or 8 bytes).",
    javaMapping: "Maps to **`int`** or **`long`** depending on the PIC scale.",
  },
  POINTER: {
    title: "USAGE POINTER",
    explanation:
      "Machine-address pointer. The W0 deterministic baseline does not generate equivalent Java; flagged as unsupported on emission.",
  },
  INDEX: {
    title: "USAGE INDEX",
    explanation:
      "Internal table-subscript value. Used by SET / SEARCH; not normally manipulated by user code.",
    javaMapping: "Maps to a private **`int`** index variable.",
  },
};

export function explainUsage(usage: string): HoverEntry | null {
  const key = usage.trim().toUpperCase();
  return USAGE_ENTRIES[key] ?? null;
}

// ---------------------------------------------------------------------------
// OCCURS clause
// ---------------------------------------------------------------------------

export interface OccursShape {
  // Lower bound (always present).
  min: number;
  // Upper bound (equal to min for fixed-OCCURS).
  max: number;
  // The variable named in `DEPENDING ON …`, if any.
  dependingOn: string | null;
}

const OCCURS_FIXED = /^OCCURS\s+(\d+)\s+TIMES?\b/i;
const OCCURS_DEPENDING =
  /^OCCURS\s+(\d+)\s+TO\s+(\d+)\s+TIMES?\s+DEPENDING\s+ON\s+([A-Za-z][A-Za-z0-9-]*)/i;

export function parseOccurs(snippet: string): OccursShape | null {
  const trimmed = snippet.trim();
  const depending = OCCURS_DEPENDING.exec(trimmed);
  if (depending) {
    return {
      min: Number(depending[1]),
      max: Number(depending[2]),
      dependingOn: depending[3] ?? null,
    };
  }
  const fixed = OCCURS_FIXED.exec(trimmed);
  if (fixed) {
    const count = Number(fixed[1]);
    return { min: count, max: count, dependingOn: null };
  }
  return null;
}

export function explainOccurs(snippet: string): HoverEntry | null {
  const shape = parseOccurs(snippet);
  if (!shape) return null;
  if (shape.dependingOn) {
    const safeName = escapeMarkdownContent(shape.dependingOn);
    return {
      title: `OCCURS ${shape.min} TO ${shape.max} DEPENDING ON ${safeName}`,
      explanation: `Variable-length table: between ${shape.min} and ${shape.max} occurrences, with the live count carried by \`${safeName}\`.`,
      javaMapping:
        "Maps to **`java.util.List<T>`** sized at runtime from the depending-on value.",
    };
  }
  return {
    title: `OCCURS ${shape.min} TIMES`,
    explanation: `Fixed-length table: exactly ${shape.min} occurrence${shape.min === 1 ? "" : "s"}.`,
    javaMapping: `Maps to a **\`T[${shape.min}]\`** array or a fixed-size **\`List<T>\`**.`,
  };
}

// ---------------------------------------------------------------------------
// VALUE clause
// ---------------------------------------------------------------------------

const VALUE_FIGURATIVE: Record<string, HoverEntry> = {
  ZERO: {
    title: "VALUE ZERO",
    explanation:
      "Initialise the item to the numeric value zero (or the character `0` for display fields).",
  },
  ZEROS: {
    title: "VALUE ZEROS",
    explanation:
      "Synonym for ZERO; initialise the item to zeros across its full width.",
  },
  ZEROES: {
    title: "VALUE ZEROES",
    explanation:
      "Synonym for ZERO; initialise the item to zeros across its full width.",
  },
  SPACE: {
    title: "VALUE SPACE",
    explanation:
      "Initialise the item to one or more space characters across its full width.",
  },
  SPACES: {
    title: "VALUE SPACES",
    explanation: "Initialise the item to spaces across its full width.",
  },
  "HIGH-VALUE": {
    title: "VALUE HIGH-VALUE",
    explanation:
      "Initialise to the highest collating value in the runtime character set (0xFF on EBCDIC).",
  },
  "HIGH-VALUES": {
    title: "VALUE HIGH-VALUES",
    explanation:
      "Initialise to the highest collating value across the full width.",
  },
  "LOW-VALUE": {
    title: "VALUE LOW-VALUE",
    explanation:
      "Initialise to the lowest collating value in the runtime character set (0x00).",
  },
  "LOW-VALUES": {
    title: "VALUE LOW-VALUES",
    explanation:
      "Initialise to the lowest collating value across the full width.",
  },
  QUOTE: {
    title: "VALUE QUOTE",
    explanation:
      "Initialise to the quotation-mark character configured by the runtime.",
  },
  QUOTES: {
    title: "VALUE QUOTES",
    explanation: "Initialise to quotation marks across the full width.",
  },
};

export function explainValue(snippet: string): HoverEntry | null {
  const trimmed = snippet.trim();
  // Strip a leading VALUE / VALUE IS, leaving just the literal.
  const stripped = trimmed.replace(/^VALUE(S)?\s+(IS\s+)?/i, "").trim();
  const upper = stripped.toUpperCase().replace(/\.$/, "").trim();
  if (VALUE_FIGURATIVE[upper]) {
    return VALUE_FIGURATIVE[upper];
  }
  if (/^['"].*['"]$/.test(stripped)) {
    return {
      title: "VALUE (string literal)",
      explanation:
        "Initial value: the quoted alphanumeric literal, left-aligned and right-padded with spaces to the item width.",
    };
  }
  if (/^[+-]?\d+(?:\.\d+)?$/.test(stripped)) {
    return {
      title: "VALUE (numeric literal)",
      explanation:
        "Initial value: the literal number, right-aligned and zero-padded to the picture scale.",
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// REDEFINES clause
// ---------------------------------------------------------------------------

const REDEFINES_PATTERN = /^REDEFINES\s+([A-Za-z][A-Za-z0-9-]*)/i;

export function explainRedefines(snippet: string): HoverEntry | null {
  const match = REDEFINES_PATTERN.exec(snippet.trim());
  if (!match || !match[1]) return null;
  const safeName = escapeMarkdownContent(match[1]);
  return {
    title: `REDEFINES ${safeName}`,
    explanation: `Aliases the storage previously declared as \`${safeName}\` — both items share the same bytes and a write to one is visible through the other.`,
    warning:
      "W0 assumption: the deterministic baseline emits both views as separate Java accessors. If the source relies on type-punning through the alias, the generated code may diverge.",
    javaMapping:
      "Both items map to accessors over the same underlying byte buffer.",
  };
}

// ---------------------------------------------------------------------------
// SECTION / PARAGRAPH headers
// ---------------------------------------------------------------------------

const SECTION_PATTERN = /^\s*([A-Za-z][A-Za-z0-9-]*)\s+SECTION\s*\./i;
const PARAGRAPH_PATTERN = /^\s*([A-Za-z][A-Za-z0-9-]*)\s*\.\s*$/;

export function explainSection(line: string): HoverEntry | null {
  const match = SECTION_PATTERN.exec(line);
  if (!match || !match[1]) return null;
  const safeName = escapeMarkdownContent(match[1]);
  return {
    title: `${safeName} SECTION`,
    explanation: `Named procedural section. \`PERFORM ${safeName}\` runs every paragraph it contains until the next SECTION header (or end of program).`,
  };
}

export function explainParagraph(line: string): HoverEntry | null {
  const match = PARAGRAPH_PATTERN.exec(line);
  if (!match || !match[1]) return null;
  // Filter out keywords that would otherwise look like paragraph names
  // when they appear alone on a line (e.g. `EXIT.`, `CONTINUE.`).
  const name = match[1].toUpperCase();
  if (RESERVED_AT_LINE_START.has(name)) return null;
  const safeName = escapeMarkdownContent(match[1]);
  return {
    title: `${safeName} (paragraph)`,
    explanation: `Named paragraph. \`PERFORM ${safeName}\` runs every sentence until the next paragraph or section header.`,
  };
}

const RESERVED_AT_LINE_START = new Set([
  "EXIT",
  "CONTINUE",
  "STOP",
  "GOBACK",
  "END-IF",
  "END-PERFORM",
  "END-EVALUATE",
  "END-READ",
  "END-WRITE",
]);

// ---------------------------------------------------------------------------
// Fixed-format zones
// ---------------------------------------------------------------------------

// COBOL fixed-format column zones. The columns are 1-based as Monaco
// reports them and as a developer reads the screen.
export interface FixedFormatZone {
  // Inclusive 1-based start column.
  startColumn: number;
  // Inclusive 1-based end column.
  endColumn: number;
  // Hover entry shown when the cursor lands inside the zone.
  entry: HoverEntry;
}

export const FIXED_FORMAT_ZONES: readonly FixedFormatZone[] = [
  {
    startColumn: 1,
    endColumn: 6,
    entry: {
      title: "Sequence number area (cols 1–6)",
      explanation:
        "Fixed-format sequence numbers. Carried over from punched-card source. Ignored by every compiler we target.",
    },
  },
  {
    startColumn: 7,
    endColumn: 7,
    entry: {
      title: "Indicator area (col 7)",
      explanation:
        "Single-character indicator: `*` or `/` marks a comment line, `-` continues the previous literal, `D` marks a debug line, blank is normal code.",
    },
  },
  {
    startColumn: 8,
    endColumn: 11,
    entry: {
      title: "Area A (cols 8–11)",
      explanation:
        "Reserved for division headers, section headers, paragraph names, and level numbers `01` / `77`. Verbs must start in Area B.",
    },
  },
  {
    startColumn: 12,
    endColumn: 72,
    entry: {
      title: "Area B (cols 12–72)",
      explanation:
        "Procedural statements, verbs, and continuation of data declarations. The main body of every fixed-format program lives here.",
    },
  },
  {
    startColumn: 73,
    endColumn: 80,
    entry: {
      title: "Identification area (cols 73–80)",
      explanation:
        "Identification / sequence area carried over from punched-card source. Ignored by the compilers we target.",
    },
  },
] as const;

export function explainFixedFormatZone(column: number): HoverEntry | null {
  for (const zone of FIXED_FORMAT_ZONES) {
    if (column >= zone.startColumn && column <= zone.endColumn) {
      return zone.entry;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Markdown assembly
// ---------------------------------------------------------------------------

// Render a HoverEntry into a markdown string suitable for
// `buildHoverMarkdown`. The structured fields are assembled with
// hand-written newlines so the rendered Monaco hover shows a clear
// title, an explanation paragraph, an optional Java mapping line, and
// an optional warning blockquote.
export function hoverEntryToMarkdownString(entry: HoverEntry): string {
  const lines: string[] = [];
  lines.push(`**${entry.title}**`);
  lines.push("");
  lines.push(entry.explanation);
  if (entry.javaMapping) {
    lines.push("");
    lines.push(entry.javaMapping);
  }
  if (entry.warning) {
    lines.push("");
    lines.push(`> ⚠ ${entry.warning}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Data-item extraction (for the Data Dictionary side panel)
// ---------------------------------------------------------------------------

export interface DataItem {
  // 1-based source line number.
  line: number;
  // Level number declared on the line (e.g. 01, 05, 77).
  level: string;
  // Item name (or FILLER).
  name: string;
  // PIC clause text if present.
  picture: string | null;
  // USAGE clause text if present.
  usage: string | null;
  // VALUE clause raw text if present.
  value: string | null;
  // OCCURS clause raw text if present.
  occurs: string | null;
  // REDEFINES target if present.
  redefines: string | null;
}

// Match a data declaration anchored at the start of a logical line.
// Captures: level-number, name. Subsequent clauses (PIC, VALUE, USAGE,
// OCCURS, REDEFINES) are extracted separately so we tolerate the
// declarative-style ordering COBOL allows.
const DATA_DECLARATION = /^\s*(?:\d{2}|77|88|66|FD|SD)\s+[A-Za-z][A-Za-z0-9-]*/;
const LEVEL_AND_NAME = /^\s*(\d{2}|77|88|66|FD|SD)\s+([A-Za-z][A-Za-z0-9-]*)/;
const PIC_CLAUSE = /\b(?:PIC|PICTURE)(?:\s+IS)?\s+([X9AVSPZ$+\-,/*B().0-9]+)/i;
const USAGE_CLAUSE =
  /\b(?:USAGE\s+(?:IS\s+)?)?(COMP-[1-5]|COMP|PACKED-DECIMAL|BINARY|DISPLAY|POINTER|INDEX)\b/i;
const VALUE_CLAUSE =
  /\bVALUE(?:S)?(?:\s+IS)?\s+(['"][^'"]*['"]|[+-]?\d+(?:\.\d+)?|ZEROS?|ZEROES|SPACES?|HIGH-VALUES?|LOW-VALUES?|QUOTES?)/i;
const OCCURS_CLAUSE =
  /\bOCCURS\s+\d+(?:\s+TO\s+\d+)?\s+TIMES?(?:\s+DEPENDING\s+ON\s+[A-Za-z][A-Za-z0-9-]*)?/i;
const REDEFINES_CLAUSE = /\bREDEFINES\s+[A-Za-z][A-Za-z0-9-]*/i;

// Lines that the editor treats as comments at the source level — they
// never carry data declarations even when they superficially look like
// one (e.g. a commented-out PIC).
function isCommentLine(line: string): boolean {
  if (/^\s*\*>/.test(line)) return true;
  // Fixed-format comment: column 7 is `*` or `/`.
  if (line.length >= 7) {
    const indicator = line[6];
    if (indicator === "*" || indicator === "/") return true;
  }
  return false;
}

export function extractDataItems(source: string): DataItem[] {
  const items: DataItem[] = [];
  const lines = source.split(/\r?\n/);
  let seenDataDivision = false;
  let inProcedureDivision = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (/\bDATA\s+DIVISION\b/i.test(line)) {
      seenDataDivision = true;
      continue;
    }
    if (/\bPROCEDURE\s+DIVISION\b/i.test(line)) {
      inProcedureDivision = true;
      continue;
    }
    if (!seenDataDivision || inProcedureDivision) continue;
    if (isCommentLine(line)) continue;
    if (!DATA_DECLARATION.test(line)) continue;
    const head = LEVEL_AND_NAME.exec(line);
    if (!head) continue;
    const pic = PIC_CLAUSE.exec(line)?.[1] ?? null;
    const usage = USAGE_CLAUSE.exec(line)?.[1] ?? null;
    const value = VALUE_CLAUSE.exec(line)?.[1] ?? null;
    const occursMatch = OCCURS_CLAUSE.exec(line);
    const occurs = occursMatch ? occursMatch[0] : null;
    const redefinesMatch = REDEFINES_CLAUSE.exec(line);
    const redefines = redefinesMatch
      ? redefinesMatch[0].replace(/^REDEFINES\s+/i, "")
      : null;
    items.push({
      line: i + 1,
      level: head[1] ?? "",
      name: head[2] ?? "",
      picture: pic,
      usage,
      value,
      occurs,
      redefines,
    });
  }
  return items;
}

// Build the hover entry that summarises a data item for the dictionary
// side panel. The summary reuses the same explanation helpers as the
// hover provider so the two surfaces never drift.
export function summariseDataItem(item: DataItem): HoverEntry {
  const safeName = escapeMarkdownContent(item.name);
  const fragments: string[] = [];
  fragments.push(`Level ${item.level}.`);
  if (item.picture) {
    const pic = explainPicture(item.picture);
    fragments.push(pic.explanation);
    if (pic.javaMapping) fragments.push(pic.javaMapping);
  }
  if (item.usage) {
    const usage = explainUsage(item.usage);
    if (usage) {
      fragments.push(usage.explanation);
      if (usage.javaMapping) fragments.push(usage.javaMapping);
    }
  }
  if (item.occurs) {
    const occurs = explainOccurs(item.occurs);
    if (occurs) {
      fragments.push(occurs.explanation);
      if (occurs.javaMapping) fragments.push(occurs.javaMapping);
    }
  }
  if (item.redefines) {
    const safeTarget = escapeMarkdownContent(item.redefines);
    fragments.push(
      `Aliases the storage of \`${safeTarget}\` (REDEFINES) — same bytes, alternate view.`,
    );
  }
  if (item.value) {
    const valueEntry = explainValue(`VALUE ${item.value}`);
    if (valueEntry) fragments.push(valueEntry.explanation);
  }
  return {
    title: `${safeName} — line ${item.line}`,
    explanation: fragments.join(" "),
  };
}
