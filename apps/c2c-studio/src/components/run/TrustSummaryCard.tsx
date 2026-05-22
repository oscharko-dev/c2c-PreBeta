"use client";

import { useEffect, useState, type FormEvent, type ReactNode } from "react";

import { copyToClipboard, useCopyFeedback } from "../ui/copyFeedback";
import { useTransformationRun } from "../../stores/transformationRun";
import type {
  BuildTestView,
  EvidenceView,
  OutputRef,
  ParityEvidenceExportResponse,
  IntentionalDivergenceDecisionRequest,
  IntentionalDivergenceDecisionResponse,
  RunSummary,
  RunWorkflowView,
  TrustCaseSummary,
  TrustSummaryView,
} from "../../types/api";
import {
  describeBuildTestResult,
  getBuildTestArtifactRefs,
  isIntentionalDivergenceTrustSummary,
  type ArtifactReferenceEntry,
} from "./runPanelUtils";

export function TrustSummaryCard({
  summary,
  buildTest,
  evidence,
  workflow,
  selectedTrustCase,
  manualDriftMessage,
  parityEvidenceExport,
  exportDisabled = false,
  onExportParityEvidenceScaffold,
}: {
  summary: RunSummary | null;
  buildTest: BuildTestView | null;
  evidence: EvidenceView | null;
  workflow: RunWorkflowView | null;
  selectedTrustCase: TrustCaseSummary | null;
  manualDriftMessage: string | null;
  parityEvidenceExport: {
    status: "idle" | "exporting" | "success" | "error";
    response: ParityEvidenceExportResponse | null;
    error: string | null;
  };
  exportDisabled?: boolean;
  onExportParityEvidenceScaffold: () => Promise<void>;
}) {
  const trust = summary?.trustSummary ?? null;
  const intentionalDivergence = isIntentionalDivergenceTrustSummary(trust);
  const {
    intentionalDivergenceDecision,
    intentionalDivergenceDecisionStatus,
    intentionalDivergenceDecisionError,
    submitIntentionalDivergenceDecision,
  } = useTransformationRun();
  const comparison = describeBuildTestResult(buildTest, intentionalDivergence);
  const buildTestRefs = getBuildTestArtifactRefs(buildTest);
  const comparisonRefs = collectComparisonRefs(buildTest, trust);
  const evidenceRefs = collectEvidenceRefs(evidence, trust);
  const [decisionDraft, setDecisionDraft] = useState<DecisionDraft>(() =>
    buildDecisionDraft(trust, intentionalDivergenceDecision),
  );
  const [decisionValidation, setDecisionValidation] = useState<string[]>([]);
  const currentDecision = intentionalDivergenceDecision?.decision ?? null;
  const decisionFormVisible = Boolean(
    summary?.runId &&
    (intentionalDivergence ||
      currentDecision ||
      buildTest?.classification?.startsWith("divergence")),
  );
  const decisionBusy = intentionalDivergenceDecisionStatus === "saving";
  const decisionError =
    intentionalDivergenceDecisionError ??
    (intentionalDivergenceDecisionStatus === "error"
      ? "The divergence decision could not be saved."
      : null);

  useEffect(() => {
    setDecisionDraft(buildDecisionDraft(trust, intentionalDivergenceDecision));
  }, [trust, intentionalDivergenceDecision]);

  const riskNotes = Array.from(
    new Set(
      [
        ...(trust ? trustWarningNotes(trust) : []),
        ...(intentionalDivergence ? [intentionalDivergenceNote(trust)] : []),
        summary?.failureMessage,
        buildTest?.note,
        evidence?.note,
        workflow?.failureMessage,
        manualDriftMessage,
      ].filter((note): note is string => Boolean(note)),
    ),
  );

  async function handleDecisionSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setDecisionValidation([]);

    const validation = validateDecisionDraft(decisionDraft);
    if (validation.length > 0) {
      setDecisionValidation(validation);
      return;
    }

    if (!summary?.runId) {
      setDecisionValidation([
        "A completed run is required before recording a divergence decision.",
      ]);
      return;
    }

    const request: IntentionalDivergenceDecisionRequest = {
      decisionId: currentDecision?.decisionId ?? null,
      rationale: decisionDraft.rationale.trim(),
      reviewer: decisionDraft.reviewer.trim(),
      linkedEvidenceRefs: parseListField(decisionDraft.linkedEvidenceRefs),
      affectedOutputs: parseListField(decisionDraft.affectedOutputs),
      supersedesPreviousDecision:
        decisionDraft.supersedesPreviousDecision || currentDecision !== null,
      invalidationNote: decisionDraft.invalidationNote.trim() || null,
      expiresAt: decisionDraft.expiresAt
        ? new Date(decisionDraft.expiresAt).toISOString()
        : null,
    };

    const result = await submitIntentionalDivergenceDecision(request);
    if (!result.ok) {
      setDecisionValidation([result.message]);
    }
  }

  return (
    <section className="rounded border border-line-2 bg-bg-1 p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-text-dim">
            Trust Summary
          </p>
          <h3 className="mt-1 text-base font-medium text-text">
            Read-only trust case snapshot
          </h3>
          <p className="mt-1 text-sm text-text-dim">
            Backend-supplied trust case, build/test, repair, and evidence
            metadata.
          </p>
        </div>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
        <div className="space-y-4">
          <SummarySection title="Trust case">
            <div className="grid gap-3 md:grid-cols-2">
              <SummaryField
                label="Trust case"
                value={
                  selectedTrustCase?.title ??
                  trust?.trustCase.trustCaseId ??
                  summary?.trustCaseId ??
                  "Unavailable"
                }
                secondary={
                  trust?.trustCase.trustCaseId ??
                  summary?.trustCaseId ??
                  selectedTrustCase?.trustCaseId ??
                  null
                }
              />
              <SummaryField
                label="Description"
                value={selectedTrustCase?.description ?? "Unavailable"}
              />
              <SummaryField
                label="Trust case version"
                value={
                  trust?.trustCase.version ??
                  summary?.trustCaseVersion ??
                  selectedTrustCase?.version ??
                  "Unavailable"
                }
              />
              <SummaryField
                label="Catalog version"
                value={
                  trust?.trustCase.catalogVersion ??
                  summary?.trustCaseCatalogVersion ??
                  selectedTrustCase?.catalogVersion ??
                  "Unavailable"
                }
              />
              <SummaryField
                label="Configuration digest"
                value={
                  trust?.trustCase.configurationDigest ??
                  summary?.trustCaseConfigurationDigest ??
                  selectedTrustCase?.configurationDigest ??
                  "Unavailable"
                }
              />
              <SummaryField
                label="Environment profile"
                value={
                  summary?.trustCaseEnvironmentProfileId ??
                  selectedTrustCase?.environmentProfileId ??
                  "Unavailable"
                }
              />
              <SummaryField
                label="Comparison policy version"
                value={
                  summary?.trustCaseComparisonPolicyVersion ??
                  selectedTrustCase?.comparisonPolicyVersion ??
                  "Unavailable"
                }
              />
              <SummaryField
                label="Program ID"
                value={
                  summary?.programId ??
                  selectedTrustCase?.programId ??
                  "Unavailable"
                }
              />
            </div>
          </SummarySection>

          <SummarySection title="Results">
            <div className="grid gap-3 md:grid-cols-2">
              <SummaryField
                label="COBOL result"
                value={
                  trust?.cobolResult.status ??
                  buildTest?.status ??
                  "Unavailable"
                }
                secondary={
                  trust?.cobolResult.normalizedOutputRef
                    ? `Normalized ref ${shortRef(trust.cobolResult.normalizedOutputRef)}`
                    : buildTest?.expectedOutputRef
                      ? `Expected ref ${shortRef(buildTest.expectedOutputRef)}`
                      : "No COBOL reference published."
                }
              />
              <SummaryField
                label="Java result"
                value={
                  trust?.javaResult.status ??
                  (buildTest
                    ? [
                        buildTest.compileStatus ?? "compile: unavailable",
                        buildTest.executionStatus ?? "execution: unavailable",
                      ].join(" · ")
                    : "Unavailable")
                }
                secondary={
                  trust?.javaResult.executionResultRef
                    ? `Execution ref ${shortRef(trust.javaResult.executionResultRef)}`
                    : trust?.javaResult.normalizedOutputRef
                      ? `Normalized ref ${shortRef(trust.javaResult.normalizedOutputRef)}`
                      : buildTest?.actualOutputRef
                        ? `Actual ref ${shortRef(buildTest.actualOutputRef)}`
                        : "No Java execution reference published."
                }
              />
              <SummaryField
                label="Comparison result"
                value={trust?.comparisonResult.status ?? comparison.label}
                secondary={
                  trust?.comparisonResult.mismatchClassification ??
                  buildTest?.diffSummary ??
                  buildTest?.comparison?.status ??
                  comparison.detail
                }
              />
              <SummaryField
                label="Repair status"
                value={
                  trust?.repair.status ??
                  workflow?.finalClassification ??
                  workflow?.state ??
                  "Unavailable"
                }
                secondary={
                  trust?.repair.repairDecisionRef
                    ? `Decision ref ${shortRef(trust.repair.repairDecisionRef)}`
                    : workflow
                      ? `Active agent ${workflow.activeAgent ?? "Unavailable"} · ${workflow.repairAttempts.length} attempt${workflow.repairAttempts.length === 1 ? "" : "s"}`
                      : "No repair workflow published."
                }
              />
              <SummaryField
                label="Trust state"
                value={describeTrustState(trust)}
                secondary={
                  trust
                    ? `Coverage ${trust.coverageStatus} · divergence ${describeDivergenceDisposition(trust.divergenceDisposition)}`
                    : "No repair workflow published."
                }
              />
            </div>
          </SummarySection>

          <SummarySection title="Intentional divergence decision">
            {decisionFormVisible ? (
              <form className="space-y-3" onSubmit={handleDecisionSubmit}>
                <div className="grid gap-3 md:grid-cols-2">
                  <LabelField
                    label="Reviewer"
                    value={decisionDraft.reviewer}
                    onChange={(value) =>
                      setDecisionDraft((prev) => ({ ...prev, reviewer: value }))
                    }
                    placeholder="Reviewer name or role"
                  />
                  <LabelField
                    label="Expiration"
                    value={decisionDraft.expiresAt}
                    onChange={(value) =>
                      setDecisionDraft((prev) => ({
                        ...prev,
                        expiresAt: value,
                      }))
                    }
                    placeholder="2026-05-21T12:00"
                    type="datetime-local"
                  />
                </div>
                <TextAreaField
                  label="Rationale"
                  value={decisionDraft.rationale}
                  onChange={(value) =>
                    setDecisionDraft((prev) => ({
                      ...prev,
                      rationale: value,
                    }))
                  }
                  placeholder="Explain why the run is intentionally not equivalent."
                />
                <TextAreaField
                  label="Linked evidence refs"
                  value={decisionDraft.linkedEvidenceRefs}
                  onChange={(value) =>
                    setDecisionDraft((prev) => ({
                      ...prev,
                      linkedEvidenceRefs: value,
                    }))
                  }
                  placeholder="Comma-separated artifact URIs from the current run"
                />
                <TextAreaField
                  label="Affected outputs"
                  value={decisionDraft.affectedOutputs}
                  onChange={(value) =>
                    setDecisionDraft((prev) => ({
                      ...prev,
                      affectedOutputs: value,
                    }))
                  }
                  placeholder="java_output, normalized_output, stderr, exit_code, evidence_summary"
                />
                <TextAreaField
                  label="Invalidation note"
                  value={decisionDraft.invalidationNote}
                  onChange={(value) =>
                    setDecisionDraft((prev) => ({
                      ...prev,
                      invalidationNote: value,
                    }))
                  }
                  placeholder="Describe what would invalidate this divergence decision."
                />
                <label className="flex items-start gap-2 text-xs text-text-dim">
                  <input
                    type="checkbox"
                    checked={decisionDraft.supersedesPreviousDecision}
                    onChange={(event) =>
                      setDecisionDraft((prev) => ({
                        ...prev,
                        supersedesPreviousDecision: event.target.checked,
                      }))
                    }
                    className="mt-0.5 h-4 w-4 rounded border-line bg-bg-0 text-accent focus:ring-accent"
                  />
                  <span>
                    Supersedes the previous decision and invalidates any prior
                    approval.
                  </span>
                </label>
                <div className="flex flex-wrap items-center gap-3">
                  <button
                    type="submit"
                    disabled={decisionBusy}
                    className="rounded border border-line-2 bg-bg-0 px-3 py-2 text-xs font-medium text-text transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {decisionBusy
                      ? "Saving..."
                      : currentDecision
                        ? "Record updated decision"
                        : "Record decision"}
                  </button>
                </div>
                {decisionValidation.length > 0 ? (
                  <div className="rounded border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs text-red-700">
                    <ul className="list-disc space-y-1 pl-4">
                      {decisionValidation.map((message) => (
                        <li key={message}>{message}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {decisionError ? (
                  <div className="rounded border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs text-red-700">
                    {decisionError}
                  </div>
                ) : null}
                {currentDecision ? (
                  <div className="rounded border border-line bg-bg-0 px-3 py-2 text-xs text-text-dim">
                    Saved decision {currentDecision.decisionId} ·{" "}
                    {currentDecision.reviewer} ·{" "}
                    {currentDecision.supersedesPreviousDecision
                      ? "supersedes prior decision"
                      : "current decision"}
                  </div>
                ) : null}
              </form>
            ) : (
              <p className="text-xs text-text-dim">
                Record the rationale, reviewer, evidence, affected outputs, and
                expiration metadata once the run has been intentionally marked
                as not equivalent.
              </p>
            )}
          </SummarySection>
        </div>

        <div className="space-y-4">
          <SummarySection title="Evidence">
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-1">
              <SummaryField
                label="Evidence timestamp"
                value={formatTimestamp(
                  trust?.evidence.recordedAt ??
                    evidence?.artifactRef?.createdAt ??
                    evidence?.exportRef?.createdAt ??
                    evidence?.generatedArtifactRef?.createdAt,
                )}
                secondary={
                  evidence?.packId ??
                  evidence?.manifestHash ??
                  "No evidence pack metadata published."
                }
              />
              <SummaryField
                label="Evidence status"
                value={
                  trust?.evidence.status ?? evidence?.status ?? "Unavailable"
                }
                secondary={
                  evidence?.note ??
                  "Read-only evidence payload from the backend."
                }
              />
            </div>

            <div className="mt-4 space-y-3">
              <ReferenceGroup title="Build/test refs" entries={buildTestRefs} />
              <ReferenceGroup
                title="Comparison refs"
                entries={comparisonRefs}
              />
              <ReferenceGroup title="Evidence refs" entries={evidenceRefs} />
            </div>
          </SummarySection>

          <SummarySection title="Parity export">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-text">
                  Export a reviewable Java regression scaffold from the current
                  parity evidence.
                </p>
                <p className="mt-1 text-xs text-text-dim">
                  The export is run-scoped and remains reviewable until a
                  developer promotes it into repository CI.
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  void onExportParityEvidenceScaffold();
                }}
                disabled={
                  exportDisabled ||
                  !evidence ||
                  parityEvidenceExport.status === "exporting"
                }
                title={
                  exportDisabled
                    ? "Rerun to export current evidence"
                    : undefined
                }
                className="rounded border border-line-2 bg-bg-0 px-3 py-2 text-xs font-medium text-text transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
              >
                {parityEvidenceExport.status === "exporting"
                  ? "Exporting scaffold..."
                  : "Export Java regression scaffold"}
              </button>
            </div>

            {parityEvidenceExport.status === "error" &&
            parityEvidenceExport.error ? (
              <div className="mt-3 rounded border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs text-red-700">
                Export failed: {parityEvidenceExport.error}
              </div>
            ) : null}

            {parityEvidenceExport.response ? (
              <div className="mt-4 grid gap-3 md:grid-cols-2">
                <SummaryField
                  label="Export status"
                  value={parityEvidenceExport.response.status}
                  secondary={parityEvidenceExport.response.message ?? null}
                />
                <SummaryField
                  label="Qualification"
                  value={describeExportQualification(
                    parityEvidenceExport.response.export.qualification,
                  )}
                  secondary={describeExportQualificationNote(
                    parityEvidenceExport.response.export.qualification,
                  )}
                />
                <SummaryField
                  label="Scaffold path"
                  value={
                    parityEvidenceExport.response.export.scaffoldRef.path ??
                    parityEvidenceExport.response.export.scaffoldTestPath ??
                    "Unavailable"
                  }
                  secondary={shortRef(
                    parityEvidenceExport.response.export.scaffoldRef,
                  )}
                />
                <SummaryField
                  label="Created at"
                  value={
                    parityEvidenceExport.response.export.createdAt ??
                    "Unavailable"
                  }
                  secondary={parityEvidenceExport.response.export.exportId}
                />
              </div>
            ) : null}

            {parityEvidenceExport.response ? (
              <div className="mt-4 space-y-3">
                <ReferenceGroup
                  title="Export refs"
                  entries={[
                    {
                      label: "Scaffold",
                      ref: parityEvidenceExport.response.export.scaffoldRef,
                    },
                    {
                      label: "Project manifest",
                      ref: parityEvidenceExport.response.export
                        .projectManifestRef,
                    },
                    {
                      label: "Export manifest",
                      ref: parityEvidenceExport.response.export.manifestRef,
                    },
                    {
                      label: "Expected output",
                      ref: parityEvidenceExport.response.export
                        .expectedOutputRef,
                    },
                  ]}
                />
              </div>
            ) : null}
          </SummarySection>

          <SummarySection title="Risk notes and warnings">
            {riskNotes.length > 0 ? (
              <ul className="space-y-2 text-xs text-text-dim">
                {riskNotes.map((note) => (
                  <li
                    key={note}
                    className="rounded border border-line bg-bg-0 px-3 py-2 text-text-dim"
                  >
                    {note}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-text-dim">
                No risk notes or warnings were published for this run.
              </p>
            )}
          </SummarySection>
        </div>
      </div>
    </section>
  );
}

function SummarySection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded border border-line-2 bg-bg-0 p-3">
      <h4 className="text-[10px] font-semibold uppercase tracking-wider text-text-dim">
        {title}
      </h4>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function SummaryField({
  label,
  value,
  secondary,
}: {
  label: string;
  value: string;
  secondary?: string | null;
}) {
  return (
    <div className="rounded border border-line bg-bg-1 px-3 py-2">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-text-faint">
        {label}
      </div>
      <div className="mt-1 break-words font-mono text-[11px] text-text">
        {value}
      </div>
      {secondary ? (
        <div className="mt-1 break-words text-[11px] text-text-dim">
          {secondary}
        </div>
      ) : null}
    </div>
  );
}

function ReferenceGroup({
  title,
  entries,
}: {
  title: string;
  entries: ReferenceEntry[];
}) {
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-text-dim">
        {title}
      </div>
      {entries.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {entries.map((entry) => (
            <ReferencePill
              key={`${title}:${entry.label}:${entry.ref?.sha256 ?? entry.label}`}
              entry={entry}
            />
          ))}
        </div>
      ) : (
        <p className="mt-2 text-xs text-text-dim">No references published.</p>
      )}
    </div>
  );
}

function ReferencePill({ entry }: { entry: ReferenceEntry }) {
  if (!entry.ref?.sha256) {
    return null;
  }

  return (
    <div className="inline-flex max-w-full items-start gap-2 rounded border border-line bg-bg-1 px-2 py-1 text-xs">
      <div className="min-w-0">
        <div className="font-semibold text-text-dim">{entry.label}</div>
        {entry.ref.path ? (
          <div className="mt-0.5 max-w-[22rem] break-all text-[11px] text-text-dim">
            {entry.ref.path}
          </div>
        ) : null}
        <div className="mt-0.5 max-w-[22rem] break-all font-mono text-[11px] text-text">
          {entry.ref.sha256}
        </div>
        {entry.ref.createdAt ? (
          <div className="mt-0.5 font-mono text-[10px] text-text-faint">
            {entry.ref.createdAt}
          </div>
        ) : null}
      </div>
      <RefCopyButton
        value={entry.ref.sha256}
        label={`Copy ${entry.label.toLowerCase()} hash`}
      />
    </div>
  );
}

function RefCopyButton({ value, label }: { value: string; label: string }) {
  const { copied, showCopied } = useCopyFeedback();

  return (
    <button
      type="button"
      onClick={() => {
        void copyToClipboard(value).then((ok) => {
          if (ok) {
            showCopied();
          }
        });
      }}
      aria-label={label}
      className="shrink-0 rounded border border-line bg-bg-0 px-2 py-1 font-mono text-[10px] text-text-dim transition-colors hover:border-accent hover:text-text focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function collectComparisonRefs(
  buildTest: BuildTestView | null,
  trust: TrustSummaryView | null,
): ReferenceEntry[] {
  return uniqueReferences([
    {
      label: "Comparison policy",
      ref: trust?.comparisonResult.comparisonPolicyRef,
    },
    {
      label: "Comparison result",
      ref: trust?.comparisonResult.comparisonResultRef,
    },
    { label: "Diff", ref: trust?.comparisonResult.diffRef },
    {
      label: "Decision record",
      ref: trust?.comparisonResult.decisionRecordRef,
    },
    {
      label: "Intentional divergence decision",
      ref: trust?.intentionalDivergenceDecisionRef,
    },
    {
      label: "Comparison policy",
      ref: buildTest?.comparison?.comparisonPolicyRef,
    },
    {
      label: "Comparison result",
      ref: buildTest?.comparison?.comparisonResultRef,
    },
    { label: "Diff", ref: buildTest?.comparison?.diffRef },
    { label: "Expected", ref: buildTest?.comparison?.expectedRef },
    { label: "Actual", ref: buildTest?.comparison?.actualRef },
  ]);
}

function collectEvidenceRefs(
  evidence: EvidenceView | null,
  trust: TrustSummaryView | null,
): ReferenceEntry[] {
  return uniqueReferences([
    { label: "Evidence pack", ref: trust?.evidence.packRef },
    { label: "Repair decision", ref: trust?.repair.repairDecisionRef },
    {
      label: "Repaired build/test",
      ref: trust?.repair.repairedBuildTestResultRef,
    },
    {
      label: "Repaired Java candidate",
      ref: trust?.repair.repairedJavaCandidateRef,
    },
    { label: "Artifact", ref: evidence?.artifactRef },
    { label: "Export", ref: evidence?.exportRef },
    { label: "Generated artifact", ref: evidence?.generatedArtifactRef },
    {
      label: "Intentional divergence decision",
      ref: trust?.intentionalDivergenceDecisionRef,
    },
  ]);
}

function trustWarningNotes(trust: TrustSummaryView): string[] {
  return trust.warningCodes.map((code) => {
    switch (code) {
      case "limited_coverage":
        return "Limited coverage: parity evidence reflects a bounded, documented coverage surface.";
      case "known_coverage_gap":
        return "Known coverage gap: the comparison outcome reflects a documented W0 limitation.";
      case "manual_edits_carried_over":
        return "Manual edits were carried into the verified Java artifact and should be reviewed alongside the deterministic evidence.";
    }
  });
}

function intentionalDivergenceNote(trust: TrustSummaryView | null): string {
  return trust
    ? "Intentional divergence: the run is governed as not equivalent, with a reviewable rationale and evidence trail."
    : "Intentional divergence: the run is governed as not equivalent.";
}

function describeTrustState(trust: TrustSummaryView | null): string {
  if (!trust) {
    return "Unavailable";
  }

  if (trust.trustState === "intentional_divergence") {
    return "Intentionally diverged";
  }

  return trust.trustState;
}

function describeDivergenceDisposition(
  disposition: TrustSummaryView["divergenceDisposition"],
): string {
  switch (disposition) {
    case "intentional":
      return "intentional divergence";
    case "known_coverage_gap":
      return "known coverage gap";
    case "none":
      return "none";
    case "unknown":
      return "unknown";
    default:
      return disposition;
  }
}

type DecisionDraft = {
  rationale: string;
  reviewer: string;
  linkedEvidenceRefs: string;
  affectedOutputs: string;
  supersedesPreviousDecision: boolean;
  invalidationNote: string;
  expiresAt: string;
};

function buildDecisionDraft(
  trust: TrustSummaryView | null,
  response: IntentionalDivergenceDecisionResponse | null,
): DecisionDraft {
  const trustEvidence =
    trust?.evidence.packRef?.sha256 ??
    trust?.comparisonResult.decisionRecordRef?.sha256 ??
    "";
  return {
    rationale: response?.decision.rationale ?? "",
    reviewer: response?.decision.reviewer ?? "",
    linkedEvidenceRefs:
      response?.decision.linkedEvidenceRefs.join(", ") ?? trustEvidence,
    affectedOutputs: response?.decision.affectedOutputs.join(", ") ?? "",
    supersedesPreviousDecision:
      response?.decision.supersedesPreviousDecision ?? false,
    invalidationNote: response?.decision.invalidationNote ?? "",
    expiresAt: formatDateTimeLocalValue(response?.decision.expiresAt),
  };
}

function formatDateTimeLocalValue(value?: string | null): string {
  if (!value) {
    return "";
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return "";
  }

  const year = parsed.getFullYear();
  const month = String(parsed.getMonth() + 1).padStart(2, "0");
  const day = String(parsed.getDate()).padStart(2, "0");
  const hours = String(parsed.getHours()).padStart(2, "0");
  const minutes = String(parsed.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

function parseListField(value: string): string[] {
  return value
    .split(/[\n,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function validateDecisionDraft(draft: DecisionDraft): string[] {
  const errors: string[] = [];
  if (draft.rationale.trim().length < 12) {
    errors.push("Rationale must be at least 12 characters long.");
  }
  if (draft.reviewer.trim().length === 0) {
    errors.push("Reviewer is required.");
  }
  const linkedEvidenceRefs = parseListField(draft.linkedEvidenceRefs);
  const affectedOutputs = parseListField(draft.affectedOutputs);
  if (linkedEvidenceRefs.length === 0) {
    errors.push("At least one linked evidence ref is required.");
  }
  if (affectedOutputs.length === 0) {
    errors.push("At least one affected output is required.");
  }
  if (
    draft.supersedesPreviousDecision &&
    draft.invalidationNote.trim().length === 0
  ) {
    errors.push(
      "An invalidation note is required when superseding a prior decision.",
    );
  }
  if (
    draft.expiresAt.trim().length > 0 &&
    Number.isNaN(Date.parse(draft.expiresAt))
  ) {
    errors.push("Expiration must be a valid date-time value.");
  }
  return errors;
}

function LabelField({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: "text" | "datetime-local";
}) {
  return (
    <label className="block text-xs text-text-dim">
      <span className="mb-1 block font-medium text-text">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="w-full rounded border border-line bg-bg-0 px-3 py-2 text-xs text-text outline-none transition-colors focus:border-accent focus:ring-1 focus:ring-accent"
      />
    </label>
  );
}

function TextAreaField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="block text-xs text-text-dim">
      <span className="mb-1 block font-medium text-text">{label}</span>
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        rows={3}
        className="w-full rounded border border-line bg-bg-0 px-3 py-2 text-xs text-text outline-none transition-colors focus:border-accent focus:ring-1 focus:ring-accent"
      />
    </label>
  );
}

function describeExportQualification(
  qualification: ParityEvidenceExportResponse["export"]["qualification"],
): string {
  switch (qualification) {
    case "clean":
      return "Clean export";
    case "stale_evidence":
      return "Stale evidence export";
    case "repair_verified":
      return "Repair-verified export";
    case "manual_edits_carried_over":
      return "Manual edits carried over";
  }
}

function describeExportQualificationNote(
  qualification: ParityEvidenceExportResponse["export"]["qualification"],
): string {
  switch (qualification) {
    case "clean":
      return "Exported from successful parity evidence.";
    case "stale_evidence":
      return "The scaffold reflects stale evidence and should be reviewed before promotion.";
    case "repair_verified":
      return "The scaffold reflects a verified repair outcome.";
    case "manual_edits_carried_over":
      return "Manual edits were carried into the exported scaffold.";
  }
}

function uniqueReferences(entries: ReferenceEntry[]): ReferenceEntry[] {
  const seen = new Set<string>();
  const unique: ReferenceEntry[] = [];

  for (const entry of entries) {
    const sha = entry.ref?.sha256;
    if (!sha || seen.has(sha)) {
      continue;
    }
    seen.add(sha);
    unique.push(entry);
  }

  return unique;
}

function shortRef(ref: OutputRef): string {
  return ref.sha256.slice(0, 12);
}

function formatTimestamp(value: string | null | undefined): string {
  return value ?? "Unavailable";
}

type ReferenceEntry = ArtifactReferenceEntry;
