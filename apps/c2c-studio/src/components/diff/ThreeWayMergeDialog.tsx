"use client";

/**
 * Studio-IDE-13 (#255): 3-Way Merge Dialog — pure presentation component.
 *
 * Shows three read-only columns (Generator Baseline, Current Manual State,
 * New Generator Output) and a per-region radio picker for conflict resolution.
 * No freeform merge editing in V1; that is W1.
 *
 * Wiring into transformationRun / GeneratedJavaEditorPane is out of scope
 * for this slice — the coordinator does that.
 */

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type MergeChoice = "manual" | "newGenerator" | "baseline";

export interface MergeConflictRegion {
  /** Stable region key supplied by the caller. */
  id: string;
  /** Coordinates in the baseline file. */
  lineRange: { startLine: number; endLine: number };
  conflictKind:
    | "conflict"
    | "manual_only"
    | "new_generator_only"
    | "baseline_only"
    | "agreed";
  baselineContent: string;
  manualContent: string;
  newGeneratorContent: string;
  /**
   * Pre-computed suggested resolution; null means the caller has no
   * preference and the user must pick explicitly.
   */
  suggestedResolution: MergeChoice | null;
  /** When true the Apply button stays disabled until the user picks. */
  needsUserPick: boolean;
}

export interface ThreeWayMergeDialogProps {
  filePath: string;
  baselineContent: string;
  manualContent: string;
  newGeneratorContent: string;
  regions: MergeConflictRegion[];
  /** Pre-existing selections (e.g. from suggestedResolution defaults). */
  initialSelections?: Record<string, MergeChoice>;
  onApply: (selections: Record<string, MergeChoice>) => void;
  onCancel: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildDefaultSelections(
  regions: MergeConflictRegion[],
  initialSelections: Record<string, MergeChoice> | undefined,
): Record<string, MergeChoice> {
  const result: Record<string, MergeChoice> = {};
  for (const r of regions) {
    if (initialSelections?.[r.id] !== undefined) {
      result[r.id] = initialSelections[r.id];
    } else if (r.suggestedResolution !== null) {
      result[r.id] = r.suggestedResolution;
    }
    // No entry ⇒ user has not picked yet.
  }
  return result;
}

/** True when Baseline is a valid third choice for this region. */
function isBaselineAvailable(
  conflictKind: MergeConflictRegion["conflictKind"],
): boolean {
  return conflictKind === "conflict" || conflictKind === "baseline_only";
}

/** True when the radio group should be disabled (auto-resolved). */
function isAutoResolved(
  conflictKind: MergeConflictRegion["conflictKind"],
): boolean {
  return conflictKind !== "conflict";
}

// ---------------------------------------------------------------------------
// Summary helpers
// ---------------------------------------------------------------------------

interface SummaryCounts {
  conflicts: number;
  autoManual: number;
  autoNewGenerator: number;
  autoAgreed: number;
}

function computeSummary(regions: MergeConflictRegion[]): SummaryCounts {
  let conflicts = 0;
  let autoManual = 0;
  let autoNewGenerator = 0;
  let autoAgreed = 0;

  for (const r of regions) {
    switch (r.conflictKind) {
      case "conflict":
        conflicts++;
        break;
      case "manual_only":
      case "baseline_only":
        // baseline_only: baseline is available but suggestion defaults to manual
        autoManual++;
        break;
      case "new_generator_only":
        autoNewGenerator++;
        break;
      case "agreed":
        autoAgreed++;
        break;
    }
  }

  return { conflicts, autoManual, autoNewGenerator, autoAgreed };
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface ReadOnlyColumnProps {
  title: string;
  content: string;
}

function ReadOnlyColumn({ title, content }: ReadOnlyColumnProps) {
  return (
    <div className="flex min-h-0 flex-col gap-1">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-text-dim">
        {title}
      </div>
      <pre className="flex-1 min-h-0 overflow-auto whitespace-pre-wrap break-words rounded border border-line-2 bg-bg-0 p-2 font-mono text-xs text-text">
        {content || "(empty)"}
      </pre>
    </div>
  );
}

interface RegionRowProps {
  region: MergeConflictRegion;
  selection: MergeChoice | undefined;
  showDetail: boolean;
  onSelect: (choice: MergeChoice) => void;
}

function RegionRow({
  region,
  selection,
  showDetail,
  onSelect,
}: RegionRowProps) {
  const disabled = isAutoResolved(region.conflictKind);
  const baselineAvailable = isBaselineAvailable(region.conflictKind);
  const rangeLabel = `${region.lineRange.startLine}–${region.lineRange.endLine}`;
  const groupLabel = `Region ${region.lineRange.startLine}-${region.lineRange.endLine}`;

  const radioId = (suffix: string) => `region-${region.id}-${suffix}`;

  return (
    <div
      className={cn(
        "rounded border p-3 text-xs",
        region.conflictKind === "conflict"
          ? "border-amber-500/40 bg-amber-500/5"
          : "border-line-2 bg-bg-0",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono font-medium text-text">
          Lines {rangeLabel}
        </span>
        <span
          className={cn(
            "rounded px-1.5 py-0.5 text-[10px] font-medium",
            region.conflictKind === "conflict"
              ? "bg-amber-500/20 text-amber-400"
              : "bg-bg-2 text-text-dim",
          )}
        >
          {region.conflictKind.replace(/_/g, " ")}
        </span>
      </div>

      <div
        role="radiogroup"
        aria-label={groupLabel}
        className={cn("mt-2 flex flex-wrap gap-4", disabled && "opacity-60")}
      >
        <label className="flex cursor-pointer items-center gap-1.5">
          <input
            type="radio"
            name={`region-${region.id}`}
            id={radioId("manual")}
            value="manual"
            checked={selection === "manual"}
            disabled={disabled}
            onChange={() => onSelect("manual")}
            className="accent-accent"
          />
          <span className="select-none text-text">Keep Manual</span>
        </label>

        <label className="flex cursor-pointer items-center gap-1.5">
          <input
            type="radio"
            name={`region-${region.id}`}
            id={radioId("newGenerator")}
            value="newGenerator"
            checked={selection === "newGenerator"}
            disabled={disabled}
            onChange={() => onSelect("newGenerator")}
            className="accent-accent"
          />
          <span className="select-none text-text">Take New Generator</span>
        </label>

        {baselineAvailable && (
          <label className="flex cursor-pointer items-center gap-1.5">
            <input
              type="radio"
              name={`region-${region.id}`}
              id={radioId("baseline")}
              value="baseline"
              checked={selection === "baseline"}
              disabled={disabled}
              onChange={() => onSelect("baseline")}
              className="accent-accent"
            />
            <span className="select-none text-text">Keep Baseline</span>
          </label>
        )}
      </div>

      {showDetail && (
        <div className="mt-3 grid grid-cols-1 gap-2 lg:grid-cols-3">
          <div>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-text-dim">
              Generator Baseline
            </div>
            <pre className="overflow-auto whitespace-pre-wrap break-words rounded border border-line-2 bg-bg-2 p-2 font-mono text-[11px] text-text">
              {region.baselineContent || "(empty)"}
            </pre>
          </div>
          <div>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-text-dim">
              Current Manual State
            </div>
            <pre className="overflow-auto whitespace-pre-wrap break-words rounded border border-line-2 bg-bg-2 p-2 font-mono text-[11px] text-text">
              {region.manualContent || "(empty)"}
            </pre>
          </div>
          <div>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-text-dim">
              New Generator Output
            </div>
            <pre className="overflow-auto whitespace-pre-wrap break-words rounded border border-line-2 bg-bg-2 p-2 font-mono text-[11px] text-text">
              {region.newGeneratorContent || "(empty)"}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main dialog
// ---------------------------------------------------------------------------

export function ThreeWayMergeDialog({
  filePath,
  baselineContent,
  manualContent,
  newGeneratorContent,
  regions,
  initialSelections,
  onApply,
  onCancel,
}: ThreeWayMergeDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  const [selections, setSelections] = useState<Record<string, MergeChoice>>(
    () => buildDefaultSelections(regions, initialSelections),
  );
  const [showDetail, setShowDetail] = useState(false);

  // Esc closes the dialog.
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onCancel();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onCancel]);

  // Focus the dialog on mount for accessible keyboard navigation.
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  const handleSelect = (regionId: string, choice: MergeChoice) => {
    setSelections((prev) => ({ ...prev, [regionId]: choice }));
  };

  const pendingPickCount = regions.filter(
    (r) => r.needsUserPick && selections[r.id] === undefined,
  ).length;
  const applyDisabled = pendingPickCount > 0;

  const summary = computeSummary(regions);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="threewaymerge-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-bg-0/80 p-6"
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="flex max-h-[90vh] w-full max-w-7xl flex-col gap-4 rounded-lg border border-line-2 bg-bg-1 p-6 outline-none focus:ring-2 focus:ring-accent"
      >
        {/* Header */}
        <header className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <h2
              id="threewaymerge-title"
              className="truncate text-base font-semibold text-text"
            >
              3-Way Merge — {filePath}
            </h2>

            {/* Summary row */}
            <p className="mt-1 text-xs text-text-dim">
              {summary.conflicts > 0 && (
                <span className="text-amber-400">
                  {summary.conflicts}{" "}
                  {summary.conflicts === 1 ? "conflict" : "conflicts"} requiring
                  choice
                </span>
              )}
              {summary.conflicts > 0 &&
                (summary.autoManual > 0 ||
                  summary.autoNewGenerator > 0 ||
                  summary.autoAgreed > 0) && (
                  <span className="text-text-dim">, </span>
                )}
              {summary.autoManual > 0 && (
                <span>{summary.autoManual} auto-resolved (manual)</span>
              )}
              {summary.autoManual > 0 &&
                (summary.autoNewGenerator > 0 || summary.autoAgreed > 0) && (
                  <span className="text-text-dim">, </span>
                )}
              {summary.autoNewGenerator > 0 && (
                <span>
                  {summary.autoNewGenerator} auto-resolved (new generator)
                </span>
              )}
              {summary.autoNewGenerator > 0 && summary.autoAgreed > 0 && (
                <span className="text-text-dim">, </span>
              )}
              {summary.autoAgreed > 0 && (
                <span>{summary.autoAgreed} auto-resolved (agreed)</span>
              )}
              {summary.conflicts === 0 &&
                summary.autoManual === 0 &&
                summary.autoNewGenerator === 0 &&
                summary.autoAgreed === 0 && <span>No regions</span>}
            </p>

            {/* V1 notice */}
            <p className="mt-0.5 text-[11px] text-text-dim">
              Mixed manual/generator edits per region are supported; freeform
              editing in the dialog is W1.
            </p>
          </div>
        </header>

        {/* Three top-level read-only columns */}
        <div
          className="grid flex-shrink-0 grid-cols-1 gap-3 lg:grid-cols-3"
          style={{ maxHeight: "200px" }}
        >
          <ReadOnlyColumn
            title="Generator Baseline"
            content={baselineContent}
          />
          <ReadOnlyColumn
            title="Current Manual State"
            content={manualContent}
          />
          <ReadOnlyColumn
            title="New Generator Output"
            content={newGeneratorContent}
          />
        </div>

        {/* Region list */}
        <div className="flex flex-1 flex-col gap-2 overflow-y-auto">
          {regions.map((region) => (
            <RegionRow
              key={region.id}
              region={region}
              selection={selections[region.id]}
              showDetail={showDetail}
              onSelect={(choice) => handleSelect(region.id, choice)}
            />
          ))}
          {regions.length === 0 && (
            <p className="text-center text-xs text-text-dim py-4">
              No regions to merge.
            </p>
          )}
        </div>

        {/* Bottom toolbar */}
        <footer className="flex shrink-0 items-center gap-3 border-t border-line-2 pt-4">
          <button
            type="button"
            onClick={() => onApply(selections)}
            disabled={applyDisabled}
            className={cn(
              "rounded px-4 py-1.5 text-xs font-medium",
              applyDisabled
                ? "cursor-not-allowed bg-accent/40 text-bg-0/60"
                : "bg-accent text-bg-0 hover:bg-accent-dim",
            )}
          >
            Apply Selection
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="rounded border border-line-2 px-3 py-1.5 text-xs text-text-dim hover:text-text"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => setShowDetail((prev) => !prev)}
            className="rounded border border-line-2 px-3 py-1.5 text-xs text-text-dim hover:text-text"
          >
            {showDetail ? "Hide Diff Detail" : "Show Diff Detail"}
          </button>
        </footer>
      </div>
    </div>
  );
}
