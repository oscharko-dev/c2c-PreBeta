"use client";

import { cn } from "@/lib/utils";

// Fixed-format COBOL column zones. Column indices are 1-based, matching the
// COBOL '85 standard. The widths are derived from the inclusive zone bounds
// (e.g., area B spans columns 12-72 inclusive, so its width is 61 columns).
interface ColumnZone {
  readonly key: string;
  readonly label: string;
  readonly description: string;
  readonly startColumn: number;
  readonly endColumn: number;
}

export const FIXED_FORMAT_ZONES: readonly ColumnZone[] = [
  {
    key: "sequence",
    label: "Seq",
    description: "Columns 1-6 — sequence number area",
    startColumn: 1,
    endColumn: 6,
  },
  {
    key: "indicator",
    label: "I",
    description:
      "Column 7 — indicator: * = comment, - = continuation, D = debug, / = page break",
    startColumn: 7,
    endColumn: 7,
  },
  {
    key: "areaA",
    label: "A",
    description: "Columns 8-11 — area A: division / section / paragraph names",
    startColumn: 8,
    endColumn: 11,
  },
  {
    key: "areaB",
    label: "B",
    description: "Columns 12-72 — area B: statements and clauses",
    startColumn: 12,
    endColumn: 72,
  },
  {
    key: "identification",
    label: "Id",
    description:
      "Columns 73-80 — identification area: source-sequence comments (ignored by the compiler)",
    startColumn: 73,
    endColumn: 80,
  },
];

interface FixedFormatRulerProps {
  readonly className?: string;
}

// Toggleable column-zone legend rendered above the Monaco editor when the user
// enables the "Fixed-format ruler" affordance in CobolEditorPane. The zones
// are laid out as a CSS grid whose column tracks are proportional to each
// zone's character width (total 80 columns), which makes the labels line up
// with the editor's monospace grid as long as both share the same character
// pitch. Monaco's vertical `rulers` option draws the precise per-column
// guides inside the editor; this legend tells the user what each zone means.
export function FixedFormatRuler({ className }: FixedFormatRulerProps) {
  return (
    <div
      role="img"
      aria-label="COBOL fixed-format column zones: sequence (1-6), indicator (7), area A (8-11), area B (12-72), identification (73-80)"
      data-testid="fixed-format-ruler"
      className={cn(
        "flex w-full overflow-hidden rounded border border-line-2 bg-bg-1 font-mono text-[10px] uppercase tracking-wider text-text-faint",
        className,
      )}
      style={{
        // Use a CSS grid sized in proportion to each zone's character width.
        // 80 columns total → each fr unit equals one COBOL character column.
        display: "grid",
        gridTemplateColumns: FIXED_FORMAT_ZONES.map(
          (zone) => `${zone.endColumn - zone.startColumn + 1}fr`,
        ).join(" "),
      }}
    >
      {FIXED_FORMAT_ZONES.map((zone) => (
        <span
          key={zone.key}
          title={zone.description}
          className="border-r border-line-2 px-1 py-0.5 last:border-r-0 truncate"
          data-zone={zone.key}
          data-start={zone.startColumn}
          data-end={zone.endColumn}
        >
          {zone.label} {zone.startColumn}
          {zone.endColumn !== zone.startColumn ? `-${zone.endColumn}` : ""}
        </span>
      ))}
    </div>
  );
}

interface FixedFormatRulerToggleProps {
  readonly enabled: boolean;
  readonly onToggle: (next: boolean) => void;
  readonly className?: string;
}

// Toggle control rendered in the editor header. Kept distinct from the ruler
// itself so callers can place the button next to other affordances and the
// ruler can be conditionally rendered without re-mounting the button.
export function FixedFormatRulerToggle({
  enabled,
  onToggle,
  className,
}: FixedFormatRulerToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label="Toggle COBOL fixed-format ruler"
      data-testid="fixed-format-ruler-toggle"
      onClick={() => onToggle(!enabled)}
      className={cn(
        "rounded border border-line-2 px-2 py-1 text-[10px] uppercase tracking-wider transition-colors",
        enabled
          ? "border-accent bg-accent/10 text-accent"
          : "text-text-dim hover:text-text",
        className,
      )}
    >
      Ruler
    </button>
  );
}
