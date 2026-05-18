// Studio-IDE-6 (#248): trust-pillar decoration model. Maps each
// `JavaRegionClassification` onto a `(marginBarClass, gutterIconClass)`
// pair and the rich Monaco hover that surfaces originClass /
// verificationOutcome / mappingClass / repair-count facts.
//
// Visual mapping (verbatim from the issue body):
//   deterministic + oracle_passed → "deterministic-passed" (green bar, "D")
//   deterministic + oracle_failed | no_oracle → "deterministic-warn"
//     (yellow bar, "D!")
//   agent_proposed + oracle_passed → "agent-passed" (blue bar, "A")
//   agent_proposed + oracle_failed | no_oracle → "agent-warn"
//     (striped blue/yellow, "A!")
//   repair_attempted (any outcome) → "repair" (striped blue/yellow, "R")
//   manual_modified → "manual-modified" (muted purple, "M*")
//   manual_edit → "manual-edit" (orange, "M+")
//
// WCAG 2.2 AA: Tailwind tokens used here resolve to CSS variables defined
// in `src/app/globals.css`. The exact contrast values are validated by
// IDE-12 hardening; this module cites the tokens it depends on so any
// future palette tweak that breaks contrast surfaces in code review.
//
// Tailwind tokens consumed (see tailwind.config.ts):
//   success / success-soft   (deterministic-passed)
//   warn / warn-soft         (deterministic-warn)
//   accent / accent-soft     (agent-passed; "accent" is the Studio blue)
//   warn-soft + accent-soft  (agent-warn, repair — striped via CSS gradient)
//   violet / violet-soft     (manual-modified)
//   orange / orange-soft     (manual-edit)
//
// The CSS that paints the bar fills and the glyph background lives in
// `src/styles/trust-pillars.css` (imported once from `globals.css`).

import type * as MonacoNs from "monaco-editor";

import type { JavaRegionClassification } from "@/types/api";

export type TrustPillarKey =
  | "deterministic-passed"
  | "deterministic-warn"
  | "agent-passed"
  | "agent-warn"
  | "repair"
  | "manual-modified"
  | "manual-edit";

export interface PillarVisual {
  key: TrustPillarKey;
  /** Applied via Monaco `linesDecorationsClassName` — paints the margin bar. */
  marginBarClass: string;
  /** Applied via Monaco `glyphMarginClassName` — paints the gutter glyph. */
  gutterIconClass: string;
  /** Plain-text title shown on hover of the gutter glyph. */
  glyphTitle: string;
  /** Additional context shown inside the region hover markdown. */
  hoverTooltip: string;
  /** a11y label for keyboard users (announced by screen readers). */
  ariaLabel: string;
}

export const TRUST_PILLAR_VISUALS: Readonly<
  Record<TrustPillarKey, PillarVisual>
> = Object.freeze({
  "deterministic-passed": {
    key: "deterministic-passed",
    marginBarClass: "c2c-trust-margin c2c-trust-margin--deterministic-passed",
    gutterIconClass: "c2c-trust-glyph c2c-trust-glyph--deterministic-passed",
    glyphTitle:
      "D — deterministic translation, oracle passed (verified equivalent)",
    hoverTooltip:
      "Deterministic translation. The COBOL oracle accepted this region as equivalent to the source.",
    ariaLabel: "Deterministic region, oracle verified.",
  },
  "deterministic-warn": {
    key: "deterministic-warn",
    marginBarClass: "c2c-trust-margin c2c-trust-margin--deterministic-warn",
    gutterIconClass: "c2c-trust-glyph c2c-trust-glyph--deterministic-warn",
    glyphTitle: "D! — deterministic translation, oracle did not pass",
    hoverTooltip:
      "Deterministic translation, but the COBOL oracle did not confirm equivalence (or no oracle ran).",
    ariaLabel: "Deterministic region, oracle did not verify.",
  },
  "agent-passed": {
    key: "agent-passed",
    marginBarClass: "c2c-trust-margin c2c-trust-margin--agent-passed",
    gutterIconClass: "c2c-trust-glyph c2c-trust-glyph--agent-passed",
    glyphTitle: "A — agent-proposed translation, oracle passed",
    hoverTooltip:
      "Proposed by an assist agent. The COBOL oracle accepted this region as equivalent.",
    ariaLabel: "Agent-proposed region, oracle verified.",
  },
  "agent-warn": {
    key: "agent-warn",
    marginBarClass: "c2c-trust-margin c2c-trust-margin--agent-warn",
    gutterIconClass: "c2c-trust-glyph c2c-trust-glyph--agent-warn",
    glyphTitle: "A! — agent-proposed, oracle did not pass",
    hoverTooltip:
      "Proposed by an assist agent. The COBOL oracle did not confirm equivalence (or no oracle ran).",
    ariaLabel: "Agent-proposed region, oracle did not verify.",
  },
  repair: {
    key: "repair",
    marginBarClass: "c2c-trust-margin c2c-trust-margin--repair",
    gutterIconClass: "c2c-trust-glyph c2c-trust-glyph--repair",
    glyphTitle: "R — repaired by the verification-repair agent",
    hoverTooltip:
      "The verification-repair agent produced this region. Inspect the repair attempts panel for the rationale chain.",
    ariaLabel: "Repaired region.",
  },
  "manual-modified": {
    key: "manual-modified",
    marginBarClass: "c2c-trust-margin c2c-trust-margin--manual-modified",
    gutterIconClass: "c2c-trust-glyph c2c-trust-glyph--manual-modified",
    glyphTitle:
      "M* — manually modified; lineage to COBOL is stale due to manual edit",
    hoverTooltip:
      "Lineage to COBOL is stale due to manual edit. Re-run the transformation to refresh the lineage map.",
    ariaLabel: "Manually modified region, lineage stale.",
  },
  "manual-edit": {
    key: "manual-edit",
    marginBarClass: "c2c-trust-margin c2c-trust-margin--manual-edit",
    gutterIconClass: "c2c-trust-glyph c2c-trust-glyph--manual-edit",
    glyphTitle:
      "M+ — region did not exist in Generator Baseline; no COBOL lineage",
    hoverTooltip:
      "Region did not exist in Generator Baseline; no COBOL lineage to display.",
    ariaLabel: "Manual addition, no COBOL lineage.",
  },
});

export function pillarFor(region: JavaRegionClassification): TrustPillarKey {
  switch (region.originClass) {
    case "deterministic":
      return region.verificationOutcome === "oracle_passed"
        ? "deterministic-passed"
        : "deterministic-warn";
    case "agent_proposed":
      return region.verificationOutcome === "oracle_passed"
        ? "agent-passed"
        : "agent-warn";
    case "repair_attempted":
      return "repair";
    case "manual_modified":
      return "manual-modified";
    case "manual_edit":
      return "manual-edit";
  }
}

export interface BuildDecorationsArgs {
  monaco: typeof MonacoNs;
  regions: readonly JavaRegionClassification[];
  /** Optional per-region context (repair count, etc.) for the rich tooltip. */
  repairCount?: number;
  manualEditCount?: number;
}

function hoverMarkdownFor(
  region: JavaRegionClassification,
  visual: PillarVisual,
  repairCount?: number,
  manualEditCount?: number,
): MonacoNs.IMarkdownString[] {
  const lines = [
    `**${visual.glyphTitle}**`,
    "",
    `- originClass: \`${region.originClass}\``,
    `- verificationOutcome: \`${region.verificationOutcome}\``,
    `- mappingClass: \`${region.mappingClass}\``,
  ];
  if (typeof repairCount === "number") {
    lines.push(`- Repair attempts: ${repairCount}`);
  }
  if (typeof manualEditCount === "number") {
    lines.push(`- Manual edits in file: ${manualEditCount}`);
  }
  lines.push("", visual.hoverTooltip);
  return [{ value: lines.join("\n"), isTrusted: false }];
}

export function buildTrustPillarDecorations(
  args: BuildDecorationsArgs,
): MonacoNs.editor.IModelDeltaDecoration[] {
  const { regions, repairCount, manualEditCount } = args;
  const decorations: MonacoNs.editor.IModelDeltaDecoration[] = [];
  for (const region of regions) {
    const key = pillarFor(region);
    const visual = TRUST_PILLAR_VISUALS[key];
    decorations.push({
      range: {
        startLineNumber: region.lineRange.startLine,
        startColumn: 1,
        endLineNumber: region.lineRange.endLine,
        endColumn: 1,
      },
      options: {
        isWholeLine: true,
        linesDecorationsClassName: visual.marginBarClass,
        glyphMarginClassName: visual.gutterIconClass,
        glyphMarginHoverMessage: { value: visual.glyphTitle },
        hoverMessage: hoverMarkdownFor(
          region,
          visual,
          repairCount,
          manualEditCount,
        ),
      },
    });
  }
  return decorations;
}

/**
 * Lineage-Coverage percentage for the active Java file. Counts unique lines
 * covered by `deterministic | agent_proposed | repair_attempted` regions
 * over `totalLines`; manual regions (`manual_modified`, `manual_edit`) are
 * excluded from the numerator (they have no valid COBOL lineage). Returns
 * an integer in `[0, 100]`.
 */
export function lineageCoveragePct(
  totalLines: number,
  regions: readonly JavaRegionClassification[],
): number {
  if (totalLines <= 0) return 0;
  const covered = new Set<number>();
  for (const region of regions) {
    if (
      region.originClass === "manual_modified" ||
      region.originClass === "manual_edit"
    ) {
      continue;
    }
    const start = Math.max(1, region.lineRange.startLine);
    const end = Math.min(totalLines, region.lineRange.endLine);
    for (let line = start; line <= end; line += 1) {
      covered.add(line);
    }
  }
  const pct = (covered.size / totalLines) * 100;
  return Math.max(0, Math.min(100, Math.round(pct)));
}
