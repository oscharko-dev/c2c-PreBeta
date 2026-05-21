"use client";

import { useCallback, useMemo } from "react";
import { Loader2, X } from "lucide-react";

import { CodeSurface } from "@/components/ui/CodeSurface";
import { Badge } from "@/components/ui/Badge";
import { useTransformationRun } from "@/stores/transformationRun";
import type { ManualCompileRepairPreviewDiagnostic } from "@/types/api";

interface ManualCompileRepairPanelProps {
  open: boolean;
  onClose: () => void;
}

function splitLines(content: string): { content: string }[] {
  const lines = content.length > 0 ? content.split(/\r?\n/) : [""];
  return lines.map((line) => ({ content: line }));
}

export function ManualCompileRepairPanel({
  open,
  onClose,
}: ManualCompileRepairPanelProps) {
  const {
    manualCompileRepair,
    javaBuffers,
    startManualCompileRepairDiagnose,
    applyManualCompileRepair,
    acceptManualCompileRepair,
    rejectManualCompileRepair,
  } = useTransformationRun();

  const session = manualCompileRepair;
  const busy =
    session?.status === "previewing" ||
    session?.status === "loading" ||
    session?.status === "applying" ||
    session?.status === "accepting" ||
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

  const startRepairAgent = useCallback(() => {
    if (!session?.runId || !session.preview) {
      return;
    }
    void startManualCompileRepairDiagnose({
      runId: session.runId,
      previewId: session.preview.previewId,
    });
  }, [session, startManualCompileRepairDiagnose]);

  const handleApply = useCallback(() => {
    void applyManualCompileRepair();
  }, [applyManualCompileRepair]);

  const handleAccept = useCallback(() => {
    void acceptManualCompileRepair().then((result) => {
      if (result.ok) {
        onClose();
      }
    });
  }, [acceptManualCompileRepair, onClose]);

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
            the preview, validate the sandbox rerun, and accept only the
            reviewed patch.
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
        {session?.status === "previewing" || session?.status === "loading" ? (
          <div className="flex h-full items-center justify-center gap-3 text-text-dim">
            <Loader2 className="animate-spin text-accent" size={18} />
            <span>
              {session.status === "previewing"
                ? "Preparing governed repair context preview..."
                : "Diagnosing governed repair context..."}
            </span>
          </div>
        ) : session?.status === "error" ? (
          <div className="rounded border border-error/20 bg-error/10 p-4 text-sm text-text">
            <p className="font-medium text-error">Governed repair unavailable.</p>
            <p className="mt-1 text-text-dim">{session.error}</p>
            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={startRepairAgent}
                disabled={!session.preview}
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
        ) : session?.status === "preview_ready" && session.preview ? (
          <div className="space-y-4">
            <section className="rounded border border-line bg-bg-1 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="incomplete" icon={true}>
                  Preview ready
                </Badge>
                <Badge variant="warning" icon={true}>
                  Server-derived context only
                </Badge>
              </div>
              <div className="mt-3 grid gap-3 md:grid-cols-2">
                <MetaRow label="Run ID" value={session.preview.runId} />
                <MetaRow
                  label="Failure category"
                  value={session.preview.failureCategory}
                />
                <MetaRow
                  label="Included files"
                  value={String(session.preview.includedFiles.length)}
                />
                <MetaRow
                  label="Diagnostics"
                  value={String(session.preview.diagnostics.length)}
                />
              </div>
              <div className="mt-4 space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wider text-text-dim">
                  Constraints
                </p>
                <ul className="space-y-1 text-sm text-text">
                  <li>Only files in the reviewed preview can be proposed.</li>
                  <li>Secrets, unrelated artifacts, and out-of-scope paths stay excluded.</li>
                  <li>Any accepted patch must first pass the sandbox rerun.</li>
                </ul>
              </div>
            </section>

            <section className="rounded border border-line bg-bg-1 p-4">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-semibold uppercase tracking-wider text-text-dim">
                  Included files
                </p>
                <span className="text-xs text-text-dim">
                  {session.preview.includedFiles.length} file
                  {session.preview.includedFiles.length === 1 ? "" : "s"}
                </span>
              </div>
              <div className="mt-3 space-y-2">
                {session.preview.includedFiles.map((file) => (
                  <div
                    key={file.path}
                    className="rounded border border-line bg-bg-0 px-3 py-2"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="break-all text-xs font-medium text-text">
                        {file.path}
                      </p>
                      <span className="rounded border border-line px-2 py-0.5 text-[10px] uppercase tracking-wider text-text-dim">
                        {file.role}
                      </span>
                    </div>
                    <p className="mt-1 text-[11px] text-text-dim">
                      sha {file.sha256.slice(0, 12)} · {file.byteSize} bytes
                    </p>
                  </div>
                ))}
              </div>
            </section>

            <section className="rounded border border-line bg-bg-1 p-4">
              <p className="text-xs font-semibold uppercase tracking-wider text-text-dim">
                Diagnostics
              </p>
              <div className="mt-3 space-y-2">
                {session.preview.diagnostics.length > 0 ? (
                  session.preview.diagnostics.map((diagnostic, index) => (
                    <DiagnosticCard
                      key={`${diagnostic.code}-${diagnostic.filePath ?? "global"}-${index}`}
                      diagnostic={diagnostic}
                    />
                  ))
                ) : (
                  <div className="rounded border border-dashed border-line bg-bg-0 p-3 text-sm text-text-dim">
                    No diagnostics were included in the reviewed context.
                  </div>
                )}
              </div>
            </section>
          </div>
        ) : session?.diagnosis && session?.candidateProject ? (
          <div className="space-y-4">
            <section className="rounded border border-line bg-bg-1 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="incomplete" icon={true}>
                  {session.status === "applying"
                    ? "Applying to sandbox"
                    : session.status === "sandbox_ready"
                      ? "Sandbox rerun ready"
                      : session.status === "accepting"
                        ? "Accepting"
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
                    "Review the proposal and validate the sandbox rerun."
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
                Sandbox rerun evidence
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
            {session?.status === "preview_ready"
              ? "Inspect the reviewed context before starting the repair agent."
              : session?.status === "sandbox_ready"
                ? "Accept only after the sandbox rerun looks correct. Reject leaves the current buffer unchanged."
                : "Review the candidate before applying it to the sandbox. Reject leaves the current buffer unchanged."}
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
            {session?.status === "preview_ready" ? (
              <button
                type="button"
                onClick={startRepairAgent}
                disabled={busy || !session.preview}
                className="rounded border border-accent/30 bg-accent/10 px-3 py-1.5 text-xs font-medium text-accent hover:bg-accent/15 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Start repair agent
              </button>
            ) : session?.status === "sandbox_ready" ||
              session?.status === "accepting" ? (
              <button
                type="button"
                onClick={handleAccept}
                disabled={busy || !session?.proposal || !session?.candidateProject}
                className="rounded border border-accent/30 bg-accent/10 px-3 py-1.5 text-xs font-medium text-accent hover:bg-accent/15 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {session?.status === "accepting" ? "Accepting..." : "Accept patch"}
              </button>
            ) : (
              <button
                type="button"
                onClick={handleApply}
                disabled={busy || !session?.proposal || !session?.candidateProject}
                className="rounded border border-accent/30 bg-accent/10 px-3 py-1.5 text-xs font-medium text-accent hover:bg-accent/15 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {session?.status === "applying"
                  ? "Applying..."
                  : "Apply to sandbox"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function DiagnosticCard({
  diagnostic,
}: {
  diagnostic: ManualCompileRepairPreviewDiagnostic;
}) {
  return (
    <div className="rounded border border-line bg-bg-0 px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded border border-line px-2 py-0.5 text-[10px] uppercase tracking-wider text-text-dim">
          {diagnostic.severity}
        </span>
        <span className="font-mono text-[11px] text-text-dim">{diagnostic.code}</span>
      </div>
      <p className="mt-2 text-sm text-text">{diagnostic.message}</p>
      {diagnostic.filePath ? (
        <p className="mt-1 break-all text-[11px] text-text-dim">
          {diagnostic.filePath}
          {diagnostic.line ? `:${diagnostic.line}` : ""}
        </p>
      ) : null}
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
