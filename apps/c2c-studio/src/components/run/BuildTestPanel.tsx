"use client";

import { useState } from "react";

import { useTransformationRun } from "../../stores/transformationRun";
import { useSourceWorkspace } from "../../stores/sourceWorkspace";
import { EquivalencePanel } from "./EquivalencePanel";
import { RunArtifactsPanel } from "./RunArtifactsPanel";
import { StackTraceView } from "./StackTraceView";
import { StatusChip } from "../ui/StatusChip";
import { MetadataRow } from "../ui/MetadataRow";
import { Tabs } from "../ui/Tabs";
import { cn } from "../../lib/utils";
import { StatusVariant } from "../../types/design";
import {
  describeBuildTestResult,
  getBuildTestArtifactRefs,
  getBuildTestMetadataItems,
  getBuildTestReferenceSummary,
  getPipelineStages,
  describeManualDriftSummary,
} from "./runPanelUtils";

export function BuildTestPanel({
  emptyState,
}: {
  emptyState: { title: string; message: string };
}) {
  const {
    state,
    manualDriftSummary = () => ({
      hasManualEdits: false,
      fileCount: 0,
      regionCount: 0,
      baselineRunIds: [],
    }),
  } = useTransformationRun();
  const { statusFlags, selectedTrustCase } = useSourceWorkspace();
  const [activeView, setActiveView] = useState<"outputs" | "diff">("outputs");

  if (state.phase === "idle") {
    return (
      <div className="p-4 space-y-2 text-sm">
        <p className="font-medium text-text">{emptyState.title}</p>
        <p className="text-text-dim">{emptyState.message}</p>
      </div>
    );
  }

  const showingHistoricalBuildTest = Boolean(
    state.previousRun?.buildTest &&
      !state.buildTest &&
      (state.phase === "starting" ||
        state.phase === "running" ||
        state.phase === "failed" ||
        state.phase === "unavailable")
  );
  const bt =
    state.buildTest ?? (showingHistoricalBuildTest ? state.previousRun?.buildTest ?? null : null);
  const displayedSummary =
    showingHistoricalBuildTest && state.previousRun
      ? state.previousRun.summary
      : state.summary;
  const trustCaseEvidenceMismatch = Boolean(
    selectedTrustCase &&
      displayedSummary?.trustCaseConfigurationDigest &&
      displayedSummary.trustCaseConfigurationDigest !==
        selectedTrustCase.configurationDigest,
  );
  const isPending =
    !bt &&
    (state.phase === "running" || state.phase === "starting");
  const manualDrift = manualDriftSummary();
  const manualDriftMessage = describeManualDriftSummary(manualDrift);
  const stages = getPipelineStages(bt, isPending, state.progress);
  const result = describeBuildTestResult(bt);
  const metadataItems = bt ? getBuildTestMetadataItems(bt) : [];
  const artifactRefs = getBuildTestArtifactRefs(bt);

  return (
    <div className="flex h-full flex-col bg-bg-0 text-sm">
      {metadataItems.length > 0 ? (
        <MetadataRow
          items={metadataItems.map((item) => ({
            label: item.label,
            value: item.value,
          }))}
        />
      ) : null}
      <div className="flex flex-1 gap-8 min-h-0 p-4">
        <div className="w-64 shrink-0 space-y-4">
          <h3 className="mb-4 font-medium text-text">Pipeline Stages</h3>
          <div className="space-y-3">
            {stages.map((stage) => (
              <StageItem
                key={stage.label}
                label={stage.label}
                status={stage.status}
                detail={stage.detail}
              />
            ))}
          </div>
        </div>
        <div className="flex min-w-0 flex-1 flex-col border-l border-line-2 pl-8 pr-2">
          {trustCaseEvidenceMismatch ? (
            <div className="mb-4 rounded border border-orange/20 bg-orange-soft px-4 py-3 text-xs text-orange">
              Existing parity results were produced from{" "}
              {displayedSummary?.trustCaseId || "another trust case"} or a
              different catalog version. Rerun to use{" "}
              {selectedTrustCase?.trustCaseId ?? "the selected trust case"}.
            </div>
          ) : null}
          {statusFlags.pendingReRun ||
          showingHistoricalBuildTest ||
          manualDriftMessage ? (
            <div className="mb-4 rounded border border-orange/20 bg-orange-soft px-4 py-3 text-xs text-orange">
              {showingHistoricalBuildTest
                ? state.phase === "failed"
                  ? "Latest rerun failed. Showing the previous parity results as stale so the last completed comparison remains accessible."
                  : "Showing the previous parity results while the latest rerun is in progress. These results are stale until the rerun completes."
                : manualDriftMessage
                  ? manualDriftMessage
                : "COBOL source changed after the last completed parity run. These parity results are stale until you rerun."}
            </div>
          ) : null}
          <div className="mb-4 rounded border border-line-2 bg-bg-1 p-4">
            <div className="flex items-start gap-3">
              <StatusChip variant={result.tone} />
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-text-dim">
                  Parity Status
                </p>
                <p className="mt-1 text-base font-medium text-text">
                  {result.label}
                </p>
                <p className="mt-1 text-sm text-text-dim">{result.detail}</p>
                {manualDriftMessage ? (
                  <p className="mt-3 text-xs text-orange">
                    {manualDriftMessage}
                  </p>
                ) : null}
              </div>
            </div>
            {artifactRefs.length > 0 ? (
              <div className="mt-4 grid gap-2 md:grid-cols-2">
                {artifactRefs.map((entry) => (
                  <div
                    key={`${entry.label}-${entry.ref?.sha256 ?? "none"}`}
                    className="rounded border border-line bg-bg-0 px-3 py-2"
                  >
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-text-dim">
                      {entry.label}
                    </p>
                    <p className="mt-1 font-mono text-xs text-text">
                      {getBuildTestReferenceSummary(entry.ref)}
                    </p>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
          {bt && bt.status !== "ok" && bt.note ? (
            <div className="mb-4">
              <StackTraceView raw={bt.note} runId={state.runId ?? null} />
            </div>
          ) : null}
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h3 className="font-medium text-text">Build & Test Parity</h3>
            <Tabs
              value={activeView}
              onValueChange={(value) =>
                setActiveView(value as "outputs" | "diff")
              }
              tabs={[
                { value: "outputs", label: "Outputs" },
                { value: "diff", label: "Diff" },
              ]}
              idBase="build-test-view"
              className="w-auto"
            />
          </div>
          <div
            id={`build-test-view-panel-${activeView}`}
            role="tabpanel"
            aria-labelledby={`build-test-view-tab-${activeView}`}
            className="min-h-0 flex-1 overflow-y-auto"
          >
            <EquivalencePanel
              buildTest={bt}
              isPending={isPending}
              view={activeView}
            />
          </div>
        </div>
      </div>
      {state.artifacts ? (
        <div className="h-48 shrink-0 border-t border-line-2 bg-bg-1">
          <RunArtifactsPanel
            artifacts={state.artifacts.artifacts}
            missingArtifacts={state.artifacts.missingArtifacts}
            errorMessage={state.artifactsError}
          />
        </div>
      ) : null}
      {!state.artifacts && state.artifactsError ? (
        <div className="border-t border-line-2 bg-bg-1 p-4">
          <p className="text-xs font-medium text-error">
            Run artifacts unavailable
          </p>
          <p className="mt-1 text-xs text-text-dim">{state.artifactsError}</p>
        </div>
      ) : null}
    </div>
  );
}

function StageItem({
  label,
  status,
  detail,
}: {
  label: string;
  status: StatusVariant;
  detail: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <StatusChip variant={status} />
      <div className="min-w-0">
        <div
          className={cn(
            "text-sm font-medium",
            status === "success"
              ? "text-text"
              : status === "error"
                ? "text-error"
                : status === "warning"
                  ? "text-warn"
                  : status === "blocked"
                    ? "text-orange"
                    : "text-text-dim",
          )}
        >
          {label}
        </div>
        <div className="mt-1 text-xs text-text-dim">{detail}</div>
      </div>
    </div>
  );
}
