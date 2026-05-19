export interface CobolFixedFormatZone {
  readonly key: string;
  readonly label: string;
  readonly description: string;
  readonly startColumn: number;
  readonly endColumn: number;
  readonly hoverTitle: string;
  readonly hoverExplanation: string;
}

// Canonical fixed-format COBOL column zones. Keep ruler guides, UI legends,
// and hover explanations derived from this single source so the boundaries
// cannot drift across editor surfaces.
export const COBOL_FIXED_FORMAT_ZONES: readonly CobolFixedFormatZone[] = [
  {
    key: "sequence",
    label: "Seq",
    description: "Columns 1-6 - sequence number area",
    startColumn: 1,
    endColumn: 6,
    hoverTitle: "Sequence number area (cols 1-6)",
    hoverExplanation:
      "Fixed-format sequence numbers. Carried over from punched-card source. Ignored by every compiler we target.",
  },
  {
    key: "indicator",
    label: "I",
    description:
      "Column 7 - indicator: * = comment, - = continuation, D = debug, / = page break",
    startColumn: 7,
    endColumn: 7,
    hoverTitle: "Indicator area (col 7)",
    hoverExplanation:
      "Single-character indicator: `*` or `/` marks a comment line, `-` continues the previous literal, `D` marks a debug line, blank is normal code.",
  },
  {
    key: "areaA",
    label: "A",
    description: "Columns 8-11 - area A: division / section / paragraph names",
    startColumn: 8,
    endColumn: 11,
    hoverTitle: "Area A (cols 8-11)",
    hoverExplanation:
      "Reserved for division headers, section headers, paragraph names, and level numbers `01` / `77`. Verbs must start in Area B.",
  },
  {
    key: "areaB",
    label: "B",
    description: "Columns 12-72 - area B: statements and clauses",
    startColumn: 12,
    endColumn: 72,
    hoverTitle: "Area B (cols 12-72)",
    hoverExplanation:
      "Procedural statements, verbs, and continuation of data declarations. The main body of every fixed-format program lives here.",
  },
  {
    key: "identification",
    label: "Id",
    description:
      "Columns 73-80 - identification area: source-sequence comments",
    startColumn: 73,
    endColumn: 80,
    hoverTitle: "Identification area (cols 73-80)",
    hoverExplanation:
      "Identification / sequence area carried over from punched-card source. Ignored by the compilers we target.",
  },
] as const;

export const FIXED_FORMAT_RULER_COLUMNS: readonly number[] =
  COBOL_FIXED_FORMAT_ZONES.map((zone) => zone.endColumn);
