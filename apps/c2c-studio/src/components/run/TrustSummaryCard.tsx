"use client";

import { type ReactNode } from "react";

import { copyToClipboard, useCopyFeedback } from "../ui/copyFeedback";
import type {
  BuildTestView,
  EvidenceView,
  OutputRef,
  RunSummary,
  RunWorkflowView,
  TrustCaseSummary,
  TrustSummaryView,
} from "../../types/api";
import {
  describeBuildTestResult,
  getBuildTestArtifactRefs,
  type ArtifactReferenceEntry,
} from "./runPanelUtils";

export function TrustSummaryCard({
  summary,
  buildTest,
  evidence,
  workflow,
  selectedTrustCase,
  manualDriftMessage,
}: {
  summary: RunSummary | null;
  buildTest: BuildTestView | null;
  evidence: EvidenceView | null;
  workflow: RunWorkflowView | null;
  selectedTrustCase: TrustCaseSummary | null;
  manualDriftMessage: string | null;
}) {
  const trust = summary?.trustSummary ?? null;
  const comparison = describeBuildTestResult(buildTest);
  const buildTestRefs = getBuildTestArtifactRefs(buildTest);
  const comparisonRefs = collectComparisonRefs(buildTest, trust);
  const evidenceRefs = collectEvidenceRefs(evidence, trust);
  const riskNotes = Array.from(
    new Set(
      [
        ...(trust ? trustWarningNotes(trust) : []),
        summary?.failureMessage,
        buildTest?.note,
        evidence?.note,
        workflow?.failureMessage,
        manualDriftMessage,
      ].filter((note): note is string => Boolean(note)),
    ),
  );

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
            Backend-supplied trust case, build/test, repair, and evidence metadata.
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
                value={summary?.trustCaseEnvironmentProfileId ?? selectedTrustCase?.environmentProfileId ?? "Unavailable"}
              />
              <SummaryField
                label="Comparison policy version"
                value={summary?.trustCaseComparisonPolicyVersion ?? selectedTrustCase?.comparisonPolicyVersion ?? "Unavailable"}
              />
              <SummaryField
                label="Program ID"
                value={summary?.programId ?? selectedTrustCase?.programId ?? "Unavailable"}
              />
            </div>
          </SummarySection>

          <SummarySection title="Results">
            <div className="grid gap-3 md:grid-cols-2">
              <SummaryField
                label="COBOL result"
                value={trust?.cobolResult.status ?? buildTest?.status ?? "Unavailable"}
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
                value={trust?.trustState ?? "Unavailable"}
                secondary={
                  trust
                    ? `Coverage ${trust.coverageStatus} · divergence ${trust.divergenceDisposition}`
                    : "No repair workflow published."
                }
              />
            </div>
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
                value={trust?.evidence.status ?? evidence?.status ?? "Unavailable"}
                secondary={
                  evidence?.note ?? "Read-only evidence payload from the backend."
                }
              />
            </div>

            <div className="mt-4 space-y-3">
              <ReferenceGroup title="Build/test refs" entries={buildTestRefs} />
              <ReferenceGroup title="Comparison refs" entries={comparisonRefs} />
              <ReferenceGroup title="Evidence refs" entries={evidenceRefs} />
            </div>
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
    { label: "Comparison policy", ref: buildTest?.comparison?.comparisonPolicyRef },
    { label: "Comparison result", ref: buildTest?.comparison?.comparisonResultRef },
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
