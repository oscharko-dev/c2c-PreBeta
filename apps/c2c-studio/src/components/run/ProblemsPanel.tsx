"use client";

// Studio-IDE-5 (#244): typed-diagnostic Problems panel.
//
// Rendering rules (from issue spec):
//   - Sortable list (severity, file, line, code, message).
//   - Click on a row → focus the editor at the diagnostic line.
//   - Hover shows `code` and `message`; HTML in `message` renders as
//     text (React's text node sanitization is the gate).
//   - Aggregation: when more than DEFAULT_MARKER_LIMIT (2000) markers
//     are emitted by the editor surface the panel renders the full
//     diagnostic list anyway and surfaces a counter for the markers
//     dropped from the editor surface.
//
// Legacy non-typed entries (unsupported features, missing artifacts,
// generic build-test status) remain visible below the typed list so
// the panel does not regress the information density of the old
// `deriveRunProblems` pipeline.

import { useMemo, useState } from "react";

import { useTransformationRun } from "@/stores/transformationRun";
import { useMarkerNavigation } from "@/lib/editor/markerNavigation";
import { StatusChip } from "@/components/ui/StatusChip";
import {
  DEFAULT_SORT,
  type DiagnosticSortKey,
  type DiagnosticSortOrder,
  collectDiagnostics,
  sortDiagnostics,
  summarize,
} from "@/lib/runDiagnostics";
import { deriveRunProblems } from "@/components/run/runPanelUtils";
import { DEFAULT_MARKER_LIMIT, partitionByOwner } from "@/lib/editor/diagnosticMarkers";
import type { Diagnostic } from "@/types/api";

interface SeverityBadgeProps {
  severity: Diagnostic["severity"];
}

function SeverityBadge({ severity }: SeverityBadgeProps) {
  const styles: Record<Diagnostic["severity"], string> = {
    error: "bg-error/10 text-error border-error/30",
    warning: "bg-warn-soft text-warn border-warn/30",
    info: "bg-bg-2 text-text-dim border-line",
    hint: "bg-accent/10 text-accent border-accent/30",
  };
  return (
    <span
      data-testid={`problems-severity-${severity}`}
      className={`inline-flex items-center rounded border px-2 py-0.5 text-[10px] font-medium uppercase ${styles[severity] ?? styles.info}`}
    >
      {severity}
    </span>
  );
}

function SortHeader({
  label,
  active,
  direction,
  onToggle,
}: {
  label: string;
  active: boolean;
  direction: "asc" | "desc";
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={`flex items-center gap-1 text-left text-[10px] font-semibold uppercase tracking-wider ${active ? "text-text" : "text-text-faint"} hover:text-text`}
    >
      <span>{label}</span>
      {active ? <span aria-hidden="true">{direction === "asc" ? "▲" : "▼"}</span> : null}
    </button>
  );
}

export function ProblemsPanel({
  emptyState,
}: {
  emptyState: { title: string; message: string };
}) {
  const { state } = useTransformationRun();
  const { navigateToDiagnostic } = useMarkerNavigation();
  const [sortOrder, setSortOrder] = useState<DiagnosticSortOrder>(DEFAULT_SORT);

  const diagnostics = useMemo(() => collectDiagnostics(state), [state]);
  const sorted = useMemo(
    () => sortDiagnostics(diagnostics, sortOrder),
    [diagnostics, sortOrder],
  );
  const summary = useMemo(() => summarize(diagnostics), [diagnostics]);
  // Studio-IDE-5 (#244 review): the editor surface caps markers
  // per-owner. A 1500-COBOL + 1500-build run does not trigger the cap
  // on any single owner, so the aggregation chip must compute the
  // truncation count per owner and sum those. We compute it via
  // `partitionByOwner` to mirror what the editors will do.
  const aggregatedOverflow = useMemo(() => {
    const byOwner = partitionByOwner(
      diagnostics.map((entry) => entry.diagnostic),
    );
    let overflow = 0;
    for (const owner of Object.keys(byOwner) as Array<
      keyof typeof byOwner
    >) {
      const renderableInEditor = byOwner[owner].filter(
        (d) => d.line !== undefined && d.filePath !== undefined,
      );
      overflow += Math.max(
        0,
        renderableInEditor.length - DEFAULT_MARKER_LIMIT,
      );
    }
    return overflow;
  }, [diagnostics]);

  const legacyProblems = useMemo(() => deriveRunProblems(state), [state]);

  if (state.phase === "idle") {
    return (
      <div className="p-4 space-y-2 text-sm">
        <p className="font-medium text-text">{emptyState.title}</p>
        <p className="text-text-dim">{emptyState.message}</p>
      </div>
    );
  }

  const onToggleSort = (key: DiagnosticSortKey) => {
    setSortOrder((current) => {
      if (current.key === key) {
        return {
          key,
          direction: current.direction === "asc" ? "desc" : "asc",
        };
      }
      return { key, direction: "asc" };
    });
  };

  return (
    <div className="p-4 h-full overflow-auto bg-bg-0 text-sm">
      <header className="mb-3 flex flex-wrap items-baseline gap-3">
        <h3 className="font-medium text-text">Diagnostics & Issues</h3>
        <ul
          className="flex items-center gap-2 text-[11px] text-text-dim"
          aria-label="Diagnostic counts"
        >
          <li>
            <span className="font-mono text-error">{summary.errorCount}</span> errors
          </li>
          <li>
            <span className="font-mono text-warn">{summary.warningCount}</span> warnings
          </li>
          <li>
            <span className="font-mono">{summary.infoCount}</span> info
          </li>
          <li>
            <span className="font-mono">{summary.hintCount}</span> hints
          </li>
        </ul>
        {aggregatedOverflow > 0 ? (
          <span
            data-testid="problems-aggregated-overflow"
            className="rounded border border-warn/30 bg-warn-soft px-2 py-0.5 text-[10px] text-warn"
            title="Marker aggregation cap reached. The Problems panel still lists every diagnostic; the editor surface shows the first 2000."
          >
            +{aggregatedOverflow} aggregated
          </span>
        ) : null}
      </header>

      {sorted.length === 0 && legacyProblems.length === 0 ? (
        <div className="text-success flex items-center gap-2">
          <StatusChip variant="success" /> No problems detected.
        </div>
      ) : null}

      {sorted.length > 0 ? (
        <table
          className="w-full text-left"
          data-testid="problems-diagnostic-table"
        >
          <thead>
            <tr className="border-b border-line-2 text-text-faint">
              <th className="py-1 pr-3" aria-sort={sortOrder.key === "severity" ? (sortOrder.direction === "asc" ? "ascending" : "descending") : "none"}>
                <SortHeader
                  label="Severity"
                  active={sortOrder.key === "severity"}
                  direction={sortOrder.direction}
                  onToggle={() => onToggleSort("severity")}
                />
              </th>
              <th className="py-1 pr-3" aria-sort={sortOrder.key === "filePath" ? (sortOrder.direction === "asc" ? "ascending" : "descending") : "none"}>
                <SortHeader
                  label="File"
                  active={sortOrder.key === "filePath"}
                  direction={sortOrder.direction}
                  onToggle={() => onToggleSort("filePath")}
                />
              </th>
              <th className="py-1 pr-3" aria-sort={sortOrder.key === "line" ? (sortOrder.direction === "asc" ? "ascending" : "descending") : "none"}>
                <SortHeader
                  label="Line"
                  active={sortOrder.key === "line"}
                  direction={sortOrder.direction}
                  onToggle={() => onToggleSort("line")}
                />
              </th>
              <th className="py-1 pr-3" aria-sort={sortOrder.key === "code" ? (sortOrder.direction === "asc" ? "ascending" : "descending") : "none"}>
                <SortHeader
                  label="Code"
                  active={sortOrder.key === "code"}
                  direction={sortOrder.direction}
                  onToggle={() => onToggleSort("code")}
                />
              </th>
              <th className="py-1 pr-3" aria-sort={sortOrder.key === "scope" ? (sortOrder.direction === "asc" ? "ascending" : "descending") : "none"}>
                <SortHeader
                  label="Source"
                  active={sortOrder.key === "scope"}
                  direction={sortOrder.direction}
                  onToggle={() => onToggleSort("scope")}
                />
              </th>
              <th className="py-1 pr-3" aria-sort={sortOrder.key === "message" ? (sortOrder.direction === "asc" ? "ascending" : "descending") : "none"}>
                <SortHeader
                  label="Message"
                  active={sortOrder.key === "message"}
                  direction={sortOrder.direction}
                  onToggle={() => onToggleSort("message")}
                />
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((entry, index) => {
              const { diagnostic, scope } = entry;
              const sourceLabel =
                diagnostic.sourceKind ?? (scope === "build-test" ? "build" : "run");
              const fileLabel = diagnostic.filePath ?? "—";
              const lineLabel = diagnostic.line ?? "—";
              const codeLabel = diagnostic.code || "—";
              // Run-level diagnostics (no filePath) stay in the
              // Problems panel only — they have no editor target per
              // ADR 0006 Decision 4.
              const hasJump =
                diagnostic.line !== undefined &&
                diagnostic.filePath !== undefined;
              return (
                <tr
                  key={`${scope}-${index}-${codeLabel}-${diagnostic.message}`}
                  className={`border-b border-line-2/50 ${hasJump ? "cursor-pointer hover:bg-bg-1" : ""}`}
                  data-testid={`problems-row-${diagnostic.severity}`}
                  onClick={() => {
                    if (hasJump) {
                      navigateToDiagnostic(diagnostic);
                    }
                  }}
                  onKeyDown={(event) => {
                    if (
                      hasJump &&
                      (event.key === "Enter" || event.key === " ")
                    ) {
                      event.preventDefault();
                      navigateToDiagnostic(diagnostic);
                    }
                  }}
                  tabIndex={hasJump ? 0 : -1}
                  title={`${codeLabel} — ${diagnostic.message}`}
                  aria-label={`${diagnostic.severity} ${codeLabel} at ${fileLabel}${diagnostic.line ? `:${diagnostic.line}` : ""}`}
                >
                  <td className="py-1 pr-3 align-top">
                    <SeverityBadge severity={diagnostic.severity} />
                  </td>
                  <td className="py-1 pr-3 align-top font-mono text-xs text-text-dim">
                    {fileLabel}
                  </td>
                  <td className="py-1 pr-3 align-top font-mono text-xs text-text-dim">
                    {lineLabel}
                  </td>
                  <td className="py-1 pr-3 align-top font-mono text-xs text-text">
                    {codeLabel}
                  </td>
                  <td className="py-1 pr-3 align-top font-mono text-[10px] uppercase text-text-faint">
                    {sourceLabel}
                  </td>
                  <td className="py-1 pr-3 align-top text-text">
                    {diagnostic.message}
                    {diagnostic.originStep ? (
                      <span className="ml-2 rounded bg-bg-2 px-1.5 py-0.5 text-[10px] text-text-faint">
                        step {diagnostic.originStep}
                      </span>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : null}

      {legacyProblems.length > 0 ? (
        <section className="mt-6 space-y-2" data-testid="problems-legacy-list">
          <h4 className="text-[11px] font-semibold uppercase tracking-wider text-text-faint">
            Other Run Issues
          </h4>
          <ul className="space-y-3">
            {legacyProblems.map((problem, idx) => (
              <li
                key={`${problem.type}-${idx}`}
                className="bg-bg-1 border border-line-2 rounded p-3 flex flex-col gap-1"
              >
                <span className="text-xs font-semibold text-error uppercase">
                  {problem.type}
                </span>
                <span className="text-text font-mono text-xs">
                  {problem.message}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
