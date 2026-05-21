"use client";

import { useCallback, useMemo } from "react";
import { Loader2, X } from "lucide-react";

import { CodeSurface } from "@/components/ui/CodeSurface";
import { Badge } from "@/components/ui/Badge";
import { useTransformationRun } from "@/stores/transformationRun";
import type {
  JavaOriginOverlay,
  ManualCompileRepairJavaFile,
} from "@/types/api";

interface ManualCompileRepairPanelProps {
  open: boolean;
  onClose: () => void;
}

function splitLines(content: string): { content: string }[] {
  const lines = content.length > 0 ? content.split(/\r?\n/) : [""];
  return lines.map((line) => ({ content: line }));
}

function buildJavaFiles(entries: Record<string, string>): ManualCompileRepairJavaFile[] {
  return Object.entries(entries)
    .map(([path, content]) => ({ path, content }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

export function ManualCompileRepairPanel({
  open,
  onClose,
}: ManualCompileRepairPanelProps) {
  const {
    state,
    manualCompileRepair,
    javaBuffers,
    startManualCompileRepairDiagnose,
    applyManualCompileRepair,
    rejectManualCompileRepair,
  } = useTransformationRun();

  const session = manualCompileRepair;
  const busy =
    session?.status === "loading" ||
    session?.status === "applying" ||
    session?.status === "rejecting";

  const changedFiles = useMemo(() => {
    if (!session?.candidateProject) {
      return [];
    }
    const proposalFiles = session.proposal?.files ?? [];
    const proposalByPath = new Map(proposalFiles.map((file) => [file.path, file]));
    const entries = Object.entries(session.candidateProject.files)
      .map(([filePath, candidateContent]) => {
        const currentContent = javaBuffers[filePath]?.content ?? "";
        const proposalFile = proposalByPath.get(filePath) ?? null;
        const changed = currentContent !== candidateContent;
        return {
          filePath,
          currentContent,
          candidateContent,
          proposalFile,
          changeType:
            proposalFile?.changeType ??
            (currentContent.length === 0 ? "add" : changed ? "modify" : "same"),
        };
      })
      .filter((entry) => entry.changeType !== "same");
    if (entries.length > 0) {
      return entries;
    }
    return Object.entries(session.candidateProject.files).map(
      ([filePath, candidateContent]) => ({
        filePath,
        currentContent: javaBuffers[filePath]?.content ?? "",
        candidateContent,
        proposalFile: proposalByPath.get(filePath) ?? null,
        changeType: proposalByPath.get(filePath)?.changeType ?? "modify",
      }),
    );
  }, [javaBuffers, session]);

  const retryDiagnose = useCallback(() => {
    if (!session?.runId || !session.entryFilePath) {
      return;
    }
    const javaFiles = buildJavaFiles(
      Object.fromEntries(
        Object.entries(javaBuffers).map(([path, entry]) => [path, entry.content]),
      ),
    );
    void startManualCompileRepairDiagnose({
      runId: session.runId,
      entryFilePath: session.entryFilePath,
      entryClass: session.entryClass ?? undefined,
      javaFiles,
      ...(state.buildTest
        ? {
            buildTestContext: {
              status: state.buildTest.status,
              classification: state.buildTest.classification,
              compileStatus: state.buildTest.compileStatus,
              executionStatus: state.buildTest.executionStatus,
              comparisonPolicy: state.buildTest.comparisonPolicy,
              expectedOutput: state.buildTest.expectedOutput,
              outputRef: state.buildTest.outputRef,
              expectedOutputRef: state.buildTest.expectedOutputRef,
              actualOutputRef: state.buildTest.actualOutputRef,
              comparison: state.buildTest.comparison ?? undefined,
            },
          }
        : {}),
      manualEditOverlays: Object.values(javaBuffers)
        .map((entry) => entry.manualEditOverlay)
        .filter((overlay): overlay is JavaOriginOverlay => overlay !== null),
    });
  }, [javaBuffers, session, startManualCompileRepairDiagnose, state.buildTest]);

  const handleApply = useCallback(() => {
    void applyManualCompileRepair().then((result) => {
      if (result.ok) {
        onClose();
      }
    });
  }, [applyManualCompileRepair, onClose]);

  const handleReject = useCallback(() => {
    void rejectManualCompileRepair().then((result) => {
      if (result.ok) {
        onClose();
      }
    });
  }, [onClose, rejectManualCompileRepair]);

  if (!open) {
    return null;
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="manual-compile-repair-title"
      className="fixed inset-0 z-50 flex flex-col bg-bg-0/96 backdrop-blur-sm"
    >
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-line bg-bg-1 px-4 py-3">
        <div className="min-w-0">
          <h2
            id="manual-compile-repair-title"
            className="truncate text-sm font-semibold text-text"
          >
            Governed Repair Review
          </h2>
          <p className="truncate text-xs text-text-dim">
            Ask Coding Agent for a reviewable repair proposal after compile
            failures, runtime exceptions, or parity mismatches, then review
            the candidate before applying it.
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close governed repair panel"
          className="rounded p-1 text-text-dim hover:bg-bg-2 hover:text-text"
        >
          <X size={16} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-4">
        {session?.status === "loading" ? (
          <div className="flex h-full items-center justify-center gap-3 text-text-dim">
            <Loader2 className="animate-spin text-accent" size={18} />
            <span>Diagnosing governed repair context...</span>
          </div>
        ) : session?.status === "error" ? (
          <div className="rounded border border-error/20 bg-error/10 p-4 text-sm text-text">
            <p className="font-medium text-error">Governed repair unavailable.</p>
            <p className="mt-1 text-text-dim">{session.error}</p>
            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={retryDiagnose}
                className="rounded border border-line px-3 py-1.5 text-xs font-medium text-text-dim hover:bg-bg-2"
              >
                Retry diagnosis
              </button>
              <button
                type="button"
                onClick={onClose}
                className="rounded border border-line px-3 py-1.5 text-xs font-medium text-text-dim hover:bg-bg-2"
              >
                Close
              </button>
            </div>
          </div>
        ) : session?.diagnosis && session?.candidateProject ? (
          <div className="space-y-4">
            <section className="rounded border border-line bg-bg-1 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="incomplete" icon={true}>
                  {session.status === "applying"
                    ? "Applying"
                    : session.status === "rejecting"
                      ? "Rejecting"
                      : "Diagnosis ready"}
                </Badge>
                {session.diagnosis.failureClass ? (
                  <Badge variant="error" icon={true}>
                    {session.diagnosis.failureClass}
                  </Badge>
                ) : null}
                {session.buildTest ? (
                  <Badge
                    variant={
                      session.buildTest.status === "ok" ? "success" : "error"
                    }
                    icon={true}
                  >
                    Build test {session.buildTest.status}
                  </Badge>
                ) : null}
              </div>
              <div className="mt-3 grid gap-3 md:grid-cols-2">
                <MetaRow label="Run ID" value={session.runId ?? "Unavailable"} />
                <MetaRow
                  label="Entry file"
                  value={session.entryFilePath ?? "Unavailable"}
                />
                <MetaRow
                  label="Proposal"
                  value={session.proposal?.proposalId ?? "Not proposed"}
                />
                <MetaRow
                  label="Recommended next step"
                  value={
                    session.diagnosis.recommendedNextAction ??
                    "Review the proposal"
                  }
                />
              </div>
              <div className="mt-4 space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wider text-text-dim">
                  Diagnosis
                </p>
                <p className="text-sm text-text">
                  {session.diagnosis.summary ??
                    session.diagnosis.likelyRootCause ??
                    "No diagnosis text was returned."}
                </p>
                {session.diagnosis.likelyRootCause &&
                session.diagnosis.summary &&
                session.diagnosis.likelyRootCause !== session.diagnosis.summary ? (
                  <p className="text-sm text-text-dim">
                    {session.diagnosis.likelyRootCause}
                  </p>
                ) : null}
              </div>
            </section>

            {session.proposal ? (
              <section className="rounded border border-line bg-bg-1 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-xs font-semibold uppercase tracking-wider text-text-dim">
                    Candidate Review
                  </p>
                  {session.proposal.patchSha256 ? (
                    <span className="rounded border border-line bg-bg-0 px-2 py-0.5 font-mono text-[10px] text-text-dim">
                      patch {session.proposal.patchSha256.slice(0, 12)}
                    </span>
                  ) : null}
                </div>
                <p className="mt-2 text-sm text-text">
                  {session.proposal.summary ??
                    "The repair proposal did not include a summary."}
                </p>
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  <MetaRow
                    label="Application state"
                    value={session.proposal.applicationState ?? "Unavailable"}
                  />
                  <MetaRow
                    label="Approval state"
                    value={session.proposal.approvalState ?? "Unavailable"}
                  />
                </div>
              </section>
            ) : null}

            <section className="space-y-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-semibold uppercase tracking-wider text-text-dim">
                  Candidate diff
                </p>
                <span className="text-xs text-text-dim">
                  {changedFiles.length} file{changedFiles.length === 1 ? "" : "s"}
                </span>
              </div>
              {changedFiles.length > 0 ? (
                changedFiles.map((entry) => (
                  <div
                    key={entry.filePath}
                    className="rounded border border-line bg-bg-1 p-3"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2 pb-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-text">
                          {entry.filePath}
                        </p>
                        {entry.proposalFile?.diff ? (
                          <p className="mt-1 text-xs text-text-dim">
                            {entry.proposalFile.diff}
                          </p>
                        ) : null}
                      </div>
                      <span className="rounded border border-line bg-bg-0 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-text-dim">
                        {entry.changeType}
                      </span>
                    </div>
                    <div className="grid gap-3 xl:grid-cols-2">
                      <CodeSurface
                        className="min-h-0 rounded border border-line-2"
                        label="Current buffer"
                        copyLabel="Copy current"
                        copyValue={entry.currentContent}
                        emptyMessage="No current content captured."
                        lines={splitLines(entry.currentContent)}
                      />
                      <CodeSurface
                        className="min-h-0 rounded border border-line-2"
                        label="Candidate repair"
                        copyLabel="Copy candidate"
                        copyValue={entry.candidateContent}
                        emptyMessage="No candidate content captured."
                        lines={splitLines(entry.candidateContent)}
                      />
                    </div>
                  </div>
                ))
              ) : (
                <div className="rounded border border-dashed border-line bg-bg-1 p-4 text-sm text-text-dim">
                  No changed files were returned for review.
                </div>
              )}
            </section>

            <section className="rounded border border-line bg-bg-1 p-4">
              <p className="text-xs font-semibold uppercase tracking-wider text-text-dim">
                Run evidence
              </p>
              {session.buildTest ? (
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  <MetaRow label="Status" value={session.buildTest.status} />
                  <MetaRow
                    label="Classification"
                    value={session.buildTest.classification}
                  />
                  <MetaRow
                    label="Execution status"
                    value={session.buildTest.executionStatus ?? "Unavailable"}
                  />
                  <MetaRow
                    label="Compile status"
                    value={session.buildTest.compileStatus ?? "Unavailable"}
                  />
                </div>
              ) : (
                <p className="mt-2 text-sm text-text-dim">
                  No build/test result was returned.
                </p>
              )}
            </section>
          </div>
        ) : (
          <div className="flex h-full items-center justify-center rounded border border-dashed border-line bg-bg-1 p-6 text-sm text-text-dim">
            Diagnostic context is not available yet.
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-line bg-bg-1 px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-xs text-text-dim">
            Review the candidate before applying it. Reject leaves the current
            buffer unchanged.
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={handleReject}
              disabled={busy || !session?.proposal}
              className="rounded border border-line px-3 py-1.5 text-xs font-medium text-text-dim hover:bg-bg-2 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {session?.status === "rejecting" ? "Rejecting..." : "Reject"}
            </button>
            <button
              type="button"
              onClick={handleApply}
              disabled={busy || !session?.proposal || !session?.candidateProject}
              className="rounded border border-accent/30 bg-accent/10 px-3 py-1.5 text-xs font-medium text-accent hover:bg-accent/15 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {session?.status === "applying" ? "Applying..." : "Apply repair"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-line bg-bg-0 px-3 py-2">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-text-dim">
        {label}
      </p>
      <p className="mt-1 break-words text-xs text-text">{value}</p>
    </div>
  );
}
