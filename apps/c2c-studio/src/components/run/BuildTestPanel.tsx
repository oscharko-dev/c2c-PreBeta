"use client";

import { useEffect, useState, type ReactNode } from "react";

import { apiClient } from "../../lib/apiClient";
import { useTransformationRun } from "../../stores/transformationRun";
import { useSourceWorkspace } from "../../stores/sourceWorkspace";
import { EquivalencePanel } from "./EquivalencePanel";
import { MetadataRow } from "../ui/MetadataRow";
import { StatusChip } from "../ui/StatusChip";
import { Tabs } from "../ui/Tabs";
import { cn } from "../../lib/utils";
import {
  buildTimelineStages,
  describeBuildTestResult,
  describeManualDriftSummary,
  getBuildTestMetadataItems,
  getEvidenceArtifactCandidates,
  type EvidenceArtifactCandidate,
  type TimelineStageDetail,
} from "./runPanelUtils";
import type { Diagnostic, GeneratedFileContent } from "../../types/api";

type InspectorTab = "overview" | "artifacts" | "outputs" | "diagnostics" | "viewer";
type ComparisonView = "outputs" | "diff";

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
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("overview");
  const [comparisonView, setComparisonView] = useState<ComparisonView>("outputs");
  const manualDrift = manualDriftSummary();
  const manualDriftMessage = describeManualDriftSummary(manualDrift);

  const isIdle = state.phase === "idle";

  const showingHistoricalBuildTest = Boolean(
    state.previousRun?.buildTest &&
      !state.buildTest &&
      (state.phase === "starting" ||
        state.phase === "running" ||
        state.phase === "failed" ||
        state.phase === "unavailable"),
  );
  const bt =
    state.buildTest ??
    (showingHistoricalBuildTest ? state.previousRun?.buildTest ?? null : null);
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
  const metadataItems = bt ? getBuildTestMetadataItems(bt) : [];
  const timelineStages = buildTimelineStages(state);
  const artifactCandidates = getEvidenceArtifactCandidates(state);
  const defaultStageId =
    timelineStages.find((stage) => stage.status === "error" || stage.status === "warning")
      ?.id ??
    timelineStages.find((stage) => stage.status === "pending")?.id ??
    "parity-comparison";
  const [selectedStageId, setSelectedStageId] = useState(defaultStageId);

  useEffect(() => {
    setSelectedStageId(defaultStageId);
  }, [defaultStageId]);

  const selectedStage =
    timelineStages.find((stage) => stage.id === selectedStageId) ??
    timelineStages[0];
  const stageArtifacts = artifactCandidates.filter(
    (artifact) => artifact.stageId === selectedStage.id,
  );
  const [selectedArtifactKey, setSelectedArtifactKey] = useState<string | null>(null);
  const selectedArtifact = (() => {
    const inStage =
      stageArtifacts.find((artifact) => artifact.key === selectedArtifactKey) ??
      null;
    if (inStage) {
      return inStage;
    }
    return stageArtifacts[0] ?? artifactCandidates[0] ?? null;
  })();

  useEffect(() => {
    if (!selectedArtifact) {
      setSelectedArtifactKey(null);
      return;
    }
    if (selectedArtifactKey !== selectedArtifact.key) {
      setSelectedArtifactKey(selectedArtifact.key);
    }
  }, [selectedArtifact, selectedArtifactKey]);

  const [artifactState, setArtifactState] = useState<{
    loading: boolean;
    error: string | null;
    data: GeneratedFileContent | null;
  }>({
    loading: false,
    error: null,
    data: null,
  });

  useEffect(() => {
    let cancelled = false;
    async function loadArtifact() {
      if (!state.runId || !selectedArtifact) {
        setArtifactState({ loading: false, error: null, data: null });
        return;
      }
      setArtifactState((prev) => ({ ...prev, loading: true, error: null }));
      const response =
        selectedArtifact.fetchKind === "generated"
          ? await apiClient.getGeneratedFile(state.runId, selectedArtifact.path)
          : await apiClient.getRunArtifactFile(state.runId, selectedArtifact.path);
      if (cancelled) {
        return;
      }
      if (response.ok) {
        setArtifactState({ loading: false, error: null, data: response.data });
        return;
      }
      setArtifactState({
        loading: false,
        error: response.message,
        data: null,
      });
    }
    void loadArtifact();
    return () => {
      cancelled = true;
    };
  }, [selectedArtifact, state.runId]);

  if (isIdle) {
    return (
      <div className="p-4 space-y-2 text-sm">
        <p className="font-medium text-text">{emptyState.title}</p>
        <p className="text-text-dim">{emptyState.message}</p>
      </div>
    );
  }

  const result = describeBuildTestResult(bt);
  const diagnostics = collectDiagnostics(state);

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
      <div className="border-b border-line-2 p-4">
        {trustCaseEvidenceMismatch ? (
          <Banner tone="warning">
            Existing parity results were produced from{" "}
            {displayedSummary?.trustCaseId || "another trust case"} or a
            different catalog version. Rerun to use{" "}
            {selectedTrustCase?.trustCaseId ?? "the selected trust case"}.
          </Banner>
        ) : null}
        {statusFlags.pendingReRun ||
        showingHistoricalBuildTest ||
        manualDriftMessage ? (
          <Banner tone="warning">
            {showingHistoricalBuildTest
              ? state.phase === "failed"
                ? "Latest rerun failed. Showing the previous parity results as stale so the last completed comparison remains accessible."
                : "Showing the previous parity results while the latest rerun is in progress. These results are stale until the rerun completes."
              : manualDriftMessage
                ? manualDriftMessage
                : "COBOL source changed after the last completed parity run. These parity results are stale until you rerun."}
          </Banner>
        ) : null}
        <div className="mt-4 flex items-start gap-3 rounded border border-line-2 bg-bg-1 p-4">
          <StatusChip variant={result.tone} />
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-wide text-text-dim">
              Parity Status
            </p>
            <p className="mt-1 text-base font-medium text-text">{result.label}</p>
            <p className="mt-1 text-sm text-text-dim">{result.detail}</p>
            {state.workflow?.failureMessage ? (
              <p className="mt-3 text-xs text-text-dim">
                {state.workflow.failureMessage}
              </p>
            ) : null}
          </div>
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        <aside className="w-80 shrink-0 border-r border-line-2 bg-bg-1">
          <div className="border-b border-line-2 px-4 py-3">
            <h3 className="font-medium text-text">Build & Test Timeline</h3>
            <p className="mt-1 text-xs text-text-dim">
              Backend-owned parity and evidence stages in chronological order.
            </p>
          </div>
          <div className="overflow-y-auto p-3">
            <div className="space-y-2" role="tablist" aria-label="Build and test timeline stages">
              {timelineStages.map((stage) => (
                <button
                  key={stage.id}
                  type="button"
                  onClick={() => setSelectedStageId(stage.id)}
                  role="tab"
                  aria-selected={selectedStage.id === stage.id}
                  aria-controls={`build-test-inspector-panel-${stage.id}`}
                  className={cn(
                    "w-full rounded border px-3 py-3 text-left transition",
                    selectedStage.id === stage.id
                      ? "border-accent bg-bg-0"
                      : "border-line-2 bg-bg-1 hover:bg-bg-0",
                  )}
                >
                  <div className="flex items-start gap-3">
                    <StatusChip variant={stage.status} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-3">
                        <span className="font-medium text-text">{stage.label}</span>
                        <span className="text-[11px] uppercase tracking-wide text-text-dim">
                          {stage.durationText}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-text-dim">{stage.detail}</p>
                      <div className="mt-2 flex items-center justify-between gap-3 text-[11px] text-text-dim">
                        <span>{stage.actor}</span>
                        <span>{stage.evidenceCount} evidence item{stage.evidenceCount === 1 ? "" : "s"}</span>
                      </div>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </aside>
        <section className="flex min-w-0 flex-1 flex-col">
          <div className="border-b border-line-2 px-4 py-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-text-dim">
                  Evidence Inspector
                </p>
                <h3 className="mt-1 text-base font-medium text-text">
                  {selectedStage.label}
                </h3>
                <p className="mt-1 text-sm text-text-dim">{selectedStage.detail}</p>
              </div>
              <div className="rounded border border-line-2 bg-bg-1 px-3 py-2 text-right text-xs">
                <div className="text-text-dim">Next recovery action</div>
                <div className="mt-1 font-medium text-text">
                  {selectedStage.actionLabel ?? "Review the available evidence"}
                </div>
              </div>
            </div>
            <Tabs
              value={inspectorTab}
              onValueChange={(value) => setInspectorTab(value as InspectorTab)}
              tabs={[
                { value: "overview", label: "Overview" },
                { value: "artifacts", label: "Artifacts" },
                { value: "outputs", label: "Outputs" },
                { value: "diagnostics", label: "Diagnostics" },
                { value: "viewer", label: "Viewer" },
              ]}
              idBase="build-test-inspector"
              className="mt-4 w-auto"
            />
          </div>
          <div
            id={`build-test-inspector-panel-${selectedStage.id}`}
            role="tabpanel"
            className="min-h-0 flex-1 overflow-y-auto p-4"
          >
            {inspectorTab === "overview" ? (
              <OverviewPanel
                selectedStage={selectedStage}
                stageArtifacts={stageArtifacts}
                workflowFailureMessage={state.workflow?.failureMessage ?? null}
                buildTestNote={bt?.note ?? null}
              />
            ) : null}
            {inspectorTab === "artifacts" ? (
              <ArtifactsPanel
                artifacts={stageArtifacts.length > 0 ? stageArtifacts : artifactCandidates}
                selectedArtifactKey={selectedArtifact?.key ?? null}
                onSelectArtifact={(artifact) => {
                  setSelectedArtifactKey(artifact.key);
                  setInspectorTab("viewer");
                }}
              />
            ) : null}
            {inspectorTab === "outputs" ? (
              <div>
                <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="font-medium text-text">Parity Outputs</p>
                    <p className="mt-1 text-xs text-text-dim">
                      Review raw outputs and the parity diff without leaving the workbench.
                    </p>
                  </div>
                  <Tabs
                    value={comparisonView}
                    onValueChange={(value) =>
                      setComparisonView(value as ComparisonView)
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
                  id={`build-test-view-panel-${comparisonView}`}
                  role="tabpanel"
                  aria-labelledby={`build-test-view-tab-${comparisonView}`}
                >
                  <EquivalencePanel
                    buildTest={bt}
                    isPending={isPending}
                    view={comparisonView}
                  />
                </div>
              </div>
            ) : null}
            {inspectorTab === "diagnostics" ? (
              <DiagnosticsPanel
                diagnostics={diagnostics}
                workflow={state.workflow}
              />
            ) : null}
            {inspectorTab === "viewer" ? (
              <ArtifactViewerPanel
                artifact={selectedArtifact}
                loading={artifactState.loading}
                error={artifactState.error}
                data={artifactState.data}
              />
            ) : null}
          </div>
        </section>
      </div>
    </div>
  );
}

function collectDiagnostics(state: ReturnType<typeof useTransformationRun>["state"]): Diagnostic[] {
  return [
    ...(state.generated?.diagnostics ?? []),
    ...(state.buildTest?.diagnostics ?? []),
  ];
}

function Banner({
  children,
  tone,
}: {
  children: ReactNode;
  tone: "warning";
}) {
  return (
    <div
      className={cn(
        "mb-3 rounded px-4 py-3 text-xs",
        tone === "warning"
          ? "border border-orange/20 bg-orange-soft text-orange"
          : "",
      )}
    >
      {children}
    </div>
  );
}

function OverviewPanel({
  selectedStage,
  stageArtifacts,
  workflowFailureMessage,
  buildTestNote,
}: {
  selectedStage: TimelineStageDetail;
  stageArtifacts: EvidenceArtifactCandidate[];
  workflowFailureMessage: string | null;
  buildTestNote: string | null;
}) {
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
      <div className="rounded border border-line-2 bg-bg-1 p-4">
        <div className="flex items-start gap-3">
          <StatusChip variant={selectedStage.status} />
          <div className="min-w-0">
            <p className="font-medium text-text">{selectedStage.label}</p>
            <p className="mt-1 text-sm text-text-dim">{selectedStage.detail}</p>
          </div>
        </div>
        <dl className="mt-4 grid gap-3 text-xs md:grid-cols-2">
          <MetaItem label="Actor" value={selectedStage.actor} />
          <MetaItem label="Duration" value={selectedStage.durationText} />
          <MetaItem
            label="Evidence items"
            value={`${stageArtifacts.length}`}
          />
          <MetaItem
            label="Recovery action"
            value={selectedStage.actionLabel ?? "Review the available evidence"}
          />
        </dl>
      </div>
      <div className="rounded border border-line-2 bg-bg-1 p-4">
        <p className="font-medium text-text">Actionable context</p>
        <p className="mt-2 text-xs text-text-dim">
          {selectedStage.diagnostic ??
            workflowFailureMessage ??
            buildTestNote ??
            "This stage has not published additional diagnostic text yet."}
        </p>
      </div>
    </div>
  );
}

function MetaItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-text-dim">{label}</dt>
      <dd className="mt-1 font-medium text-text">{value}</dd>
    </div>
  );
}

function ArtifactsPanel({
  artifacts,
  selectedArtifactKey,
  onSelectArtifact,
}: {
  artifacts: EvidenceArtifactCandidate[];
  selectedArtifactKey: string | null;
  onSelectArtifact: (artifact: EvidenceArtifactCandidate) => void;
}) {
  if (artifacts.length === 0) {
    return (
      <div className="rounded border border-dashed border-line-2 bg-bg-1 p-6 text-sm text-text-dim">
        No stage-specific artifacts are available yet.
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded border border-line-2 bg-bg-1">
      <table className="w-full text-left text-xs">
        <thead className="border-b border-line-2 bg-bg-2 text-text-dim">
          <tr>
            <th className="px-3 py-2 font-medium">Artifact</th>
            <th className="px-3 py-2 font-medium">Kind</th>
            <th className="px-3 py-2 font-medium">Summary</th>
          </tr>
        </thead>
        <tbody>
          {artifacts.map((artifact) => (
            <tr
              key={artifact.key}
              className={cn(
                "border-b border-line-2 last:border-b-0",
                selectedArtifactKey === artifact.key ? "bg-bg-0" : "bg-bg-1",
              )}
            >
              <td className="px-3 py-2">
                <button
                  type="button"
                  onClick={() => onSelectArtifact(artifact)}
                  className="text-left text-text hover:text-accent"
                >
                  <span className="font-medium">{artifact.label}</span>
                  <span className="mt-1 block font-mono text-[11px] text-text-dim">
                    {artifact.path}
                  </span>
                </button>
              </td>
              <td className="px-3 py-2 text-text-dim">{artifact.kind}</td>
              <td className="px-3 py-2 font-mono text-text-dim">
                {artifact.summary}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DiagnosticsPanel({
  diagnostics,
  workflow,
}: {
  diagnostics: Diagnostic[];
  workflow: ReturnType<typeof useTransformationRun>["state"]["workflow"];
}) {
  return (
    <div className="space-y-4">
      {workflow?.repairAttempts?.length ? (
        <div className="rounded border border-line-2 bg-bg-1 p-4">
          <p className="font-medium text-text">Repair diagnostics</p>
          <ul className="mt-3 space-y-2 text-xs text-text-dim">
            {workflow.repairAttempts.map((attempt) => (
              <li key={attempt.attemptNumber} className="rounded border border-line bg-bg-0 p-3">
                Attempt {attempt.attemptNumber}: {attempt.repairDecision}
                {attempt.failureCategory ? ` · ${attempt.failureCategory}` : ""}
                {attempt.rationale ? ` · ${attempt.rationale}` : ""}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {diagnostics.length === 0 ? (
        <div className="rounded border border-dashed border-line-2 bg-bg-1 p-6 text-sm text-text-dim">
          No diagnostics are available for the current run.
        </div>
      ) : (
        <div className="overflow-hidden rounded border border-line-2 bg-bg-1">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-line-2 bg-bg-2 text-text-dim">
              <tr>
                <th className="px-3 py-2 font-medium">Severity</th>
                <th className="px-3 py-2 font-medium">Code</th>
                <th className="px-3 py-2 font-medium">Location</th>
                <th className="px-3 py-2 font-medium">Message</th>
              </tr>
            </thead>
            <tbody>
              {diagnostics.map((diagnostic, index) => (
                <tr key={`${diagnostic.code}-${index}`} className="border-b border-line-2 last:border-b-0">
                  <td className="px-3 py-2">{diagnostic.severity}</td>
                  <td className="px-3 py-2 font-mono">{diagnostic.code}</td>
                  <td className="px-3 py-2 text-text-dim">
                    {diagnostic.filePath ?? "Run-level"}
                    {diagnostic.line ? `:${diagnostic.line}` : ""}
                  </td>
                  <td className="px-3 py-2 text-text">{diagnostic.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ArtifactViewerPanel({
  artifact,
  loading,
  error,
  data,
}: {
  artifact: EvidenceArtifactCandidate | null;
  loading: boolean;
  error: string | null;
  data: GeneratedFileContent | null;
}) {
  if (!artifact) {
    return (
      <div className="rounded border border-dashed border-line-2 bg-bg-1 p-6 text-sm text-text-dim">
        Select an artifact to inspect its content.
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <div className="rounded border border-line-2 bg-bg-1 p-4">
        <p className="font-medium text-text">{artifact.label}</p>
        <p className="mt-1 font-mono text-xs text-text-dim">{artifact.path}</p>
        <p className="mt-2 text-xs text-text-dim">{artifact.summary}</p>
      </div>
      {loading ? (
        <div className="rounded border border-dashed border-line-2 bg-bg-1 p-6 text-sm text-text-dim">
          Loading artifact content…
        </div>
      ) : error ? (
        <div className="rounded border border-line-2 bg-bg-1 p-6 text-sm text-error">
          {error}
        </div>
      ) : data ? (
        <div className="overflow-hidden rounded border border-line-2 bg-bg-1">
          <div className="border-b border-line-2 bg-bg-2 px-4 py-2 text-xs text-text-dim">
            {data.mimeType || "text/plain"} · {data.byteSize} bytes
          </div>
          <pre className="max-h-[32rem] overflow-auto p-4 font-mono text-xs text-text whitespace-pre-wrap">
            {data.content}
          </pre>
        </div>
      ) : (
        <div className="rounded border border-dashed border-line-2 bg-bg-1 p-6 text-sm text-text-dim">
          The selected artifact does not expose text content.
        </div>
      )}
    </div>
  );
}
