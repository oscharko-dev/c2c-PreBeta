"use client";

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useGeneratedArtifacts } from "../../hooks/useGeneratedArtifacts";
import { Loader2 } from "lucide-react";
import { UnsupportedConstructsPanel } from "../state/UnsupportedConstructsPanel";
import { MissingArtifactsPanel } from "../state/MissingArtifactsPanel";
import { BlockedState } from "../state/BlockedState";
import { ErrorNotice } from "../state/ErrorNotice";
import { Badge } from "../ui/Badge";
import { useTransformationRun } from "../../stores/transformationRun";
import { VirtualizedCodeBlock } from "../ui/VirtualizedCodeBlock";
import {
  ConflictResolverDialog,
  type ConflictPanel,
} from "../source/ConflictResolverDialog";

const SAVE_NOTICE_VISIBLE_MS = 2500;

export function GeneratedJavaEditorPane() {
  const {
    selectedFilePath,
    selectedFileRef,
    fileContent,
    isFetchingFile,
    fileFetchError,
    artifactDetails,
    unavailableFiles,
  } = useGeneratedArtifacts();

  const {
    state,
    productState,
    javaBuffers,
    javaConflict,
    saveNoticeAt,
    ensureJavaBaseline,
    saveJavaDraft,
    loadJavaDraftFor,
    resolveJavaConflict,
    dismissJavaConflict,
    javaStatusFlags,
  } = useTransformationRun();

  const containerRef = useRef<HTMLDivElement>(null);
  const [showSaveNotice, setShowSaveNotice] = useState(false);

  // Hydrate the Java buffer for this (runId, filePath) when content lands.
  // Studio-IDE-3 (#247): even before IDE-4 (#245) makes the editor editable,
  // we keep the buffer model populated so status chips and conflict
  // resolution have something to compare against, and so reload paths
  // pick up any persisted draft transparently.
  useEffect(() => {
    if (
      !selectedFilePath ||
      fileContent === null ||
      !state.runId ||
      isFetchingFile
    ) {
      return;
    }
    void ensureJavaBaseline(selectedFilePath, fileContent, state.runId);
    void loadJavaDraftFor(selectedFilePath, fileContent);
  }, [
    selectedFilePath,
    fileContent,
    state.runId,
    isFetchingFile,
    ensureJavaBaseline,
    loadJavaDraftFor,
  ]);

  useEffect(() => {
    if (saveNoticeAt === null) {
      return;
    }
    setShowSaveNotice(true);
    const handle = setTimeout(
      () => setShowSaveNotice(false),
      SAVE_NOTICE_VISIBLE_MS,
    );
    return () => clearTimeout(handle);
  }, [saveNoticeAt]);

  // Bind Cmd/Ctrl+S to "save Java draft" when the focus is inside the
  // Java pane container. Until IDE-4 (#245) wires Monaco for Java, the
  // VirtualizedCodeBlock surface is the only focus target inside the
  // container; the global keyboard-shortcut hook ignores keydowns when
  // an editable element has focus, so this pane-scoped listener is
  // necessary even when the surface is non-editable.
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const isSave =
        (event.metaKey || event.ctrlKey) &&
        !event.shiftKey &&
        !event.altKey &&
        event.key.toLowerCase() === "s";
      if (!isSave) {
        return;
      }
      if (!selectedFilePath) {
        return;
      }
      event.preventDefault();
      void saveJavaDraft(selectedFilePath);
    },
    [saveJavaDraft, selectedFilePath],
  );

  const conflictForThisFile =
    javaConflict && javaConflict.filePath === selectedFilePath
      ? javaConflict
      : null;

  const conflictPanels: ConflictPanel[] = useMemo(() => {
    if (!conflictForThisFile) {
      return [];
    }
    return [
      {
        id: "backendSample",
        title: "Backend sample",
        description:
          "The Java file as supplied by the BFF for the current run.",
        content: conflictForThisFile.backendSample,
      },
      {
        id: "localDraft",
        title: "Local draft",
        description: "Edits saved locally on this device.",
        content: conflictForThisFile.localDraft,
      },
      {
        id: "lastRunInput",
        title: "Last run input",
        description: "The Java content associated with the last completed run.",
        content: conflictForThisFile.lastRunInput,
      },
    ];
  }, [conflictForThisFile]);

  const flags = selectedFilePath
    ? javaStatusFlags(selectedFilePath)
    : { clean: false, pendingReRun: false, staleJava: false };
  const javaBufferEntry = selectedFilePath
    ? javaBuffers[selectedFilePath]
    : undefined;
  // When the Java buffer has user-edits, prefer the buffer content over the
  // BFF response. Today only drafts loaded from IndexedDB hit this branch
  // (IDE-4 will populate it on each keystroke).
  const displayedContent = javaBufferEntry?.isDirty
    ? javaBufferEntry.content
    : fileContent;

  if (productState.state === "empty") {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-text-dim">
        <p>No active run. Start a transformation to see generated Java.</p>
      </div>
    );
  }

  if (
    productState.state === "running" ||
    productState.state === "submitting" ||
    productState.state === "awaiting-agent" ||
    productState.state === "repairing" ||
    productState.state === "verifying" ||
    productState.state === "generated-pending"
  ) {
    const inProgressMessage =
      productState.state === "submitting"
        ? "Submitting transformation request..."
        : productState.state === "awaiting-agent"
          ? "Awaiting transformation agent..."
          : productState.state === "repairing"
            ? "Verification & Repair Agent is proposing a candidate..."
            : productState.state === "verifying"
              ? "Verifying generated Java..."
              : "Generating Java artifacts...";
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-text-dim flex-col gap-4">
        <Loader2 className="animate-spin text-accent" size={32} />
        <p
          data-testid="generated-pane-progress"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {inProgressMessage}
        </p>
      </div>
    );
  }

  if (productState.state === "unsupported") {
    return (
      <div className="flex flex-col h-full items-center justify-center p-6">
        <BlockedState
          reason="Unsupported COBOL Constructs"
          details={productState.message}
        />
        <UnsupportedConstructsPanel
          constructs={productState.unsupportedFeatures || []}
        />
      </div>
    );
  }

  if (productState.state === "generated-incomplete") {
    return (
      <div className="flex flex-col h-full items-center justify-center p-6">
        <BlockedState
          reason="Incomplete Generation"
          details={
            productState.message || "Generation did not complete normally."
          }
        />
        <MissingArtifactsPanel
          artifacts={productState.missingArtifacts || []}
        />
      </div>
    );
  }

  if (
    (productState.state === "backend-unavailable" ||
      productState.state === "upstream-unavailable" ||
      productState.state === "validation-error") &&
    !state.generated
  ) {
    return (
      <div className="flex flex-col h-full items-center justify-center p-6">
        <BlockedState
          reason={
            productState.state === "backend-unavailable"
              ? "Backend Unavailable"
              : productState.state === "upstream-unavailable"
                ? "Upstream Service Unavailable"
                : "Transformation Validation Error"
          }
          details={productState.message}
        />
      </div>
    );
  }

  const showVerificationNotice =
    productState.state === "failed" ||
    productState.state === "blocked" ||
    productState.state === "cancelled" ||
    productState.state === "build-failed" ||
    productState.state === "equivalence-mismatch" ||
    productState.state === "evidence-incomplete" ||
    productState.state === "hash-mismatch" ||
    productState.state === "backend-unavailable" ||
    productState.state === "upstream-unavailable";

  const verificationNoticeMessage =
    productState.state === "hash-mismatch"
      ? "Artifact hashes do not align across generated Java, build/test, and evidence. Verified state is blocked."
      : productState.state === "evidence-incomplete"
        ? productState.message ||
          "Evidence is incomplete. Generated Java remains visible, but verification is blocked."
        : productState.state === "equivalence-mismatch"
          ? productState.message ||
            "Java output diverges from the COBOL oracle."
          : productState.state === "build-failed"
            ? productState.message || "Build or test execution failed."
            : productState.state === "failed"
              ? productState.message ||
                "The transformation run failed before verification completed."
              : productState.state === "cancelled"
                ? productState.message ||
                  "The run was cancelled before verification completed."
                : productState.state === "blocked"
                  ? productState.message ||
                    "The run is blocked by a precondition and cannot proceed."
                  : productState.message;

  // Displaying actual content
  return (
    <div
      ref={containerRef}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      className="flex flex-col h-full overflow-hidden relative bg-bg-0 outline-none"
      aria-label="Generated Java Editor"
    >
      <div className="flex items-center justify-between border-b border-line px-4 py-2 shrink-0 bg-bg-1">
        <div className="flex items-center gap-2 overflow-hidden">
          <h2 className="text-sm font-medium text-text truncate">
            {selectedFilePath
              ? selectedFilePath.split("/").pop()
              : "Generated Java"}
          </h2>
          {selectedFilePath && (
            <span className="text-xs text-text-dim truncate">
              {selectedFilePath}
            </span>
          )}
          <JavaStatusChips
            clean={flags.clean}
            pendingReRun={flags.pendingReRun}
            staleJava={flags.staleJava}
          />
        </div>
        <div className="flex gap-2">
          {productState.state === "failed" && (
            <Badge variant="error" icon={true}>
              Run Failed
            </Badge>
          )}
          {productState.state === "build-failed" && (
            <Badge variant="error" icon={true}>
              Verification Failed
            </Badge>
          )}
          {productState.state === "equivalence-mismatch" && (
            <Badge variant="error" icon={true}>
              Equivalence Mismatch
            </Badge>
          )}
          {productState.state === "evidence-incomplete" && (
            <Badge variant="incomplete" icon={true}>
              Evidence Incomplete
            </Badge>
          )}
          {productState.state === "hash-mismatch" && (
            <Badge variant="error" icon={true}>
              Artifact Mismatch
            </Badge>
          )}
          {productState.state === "success" && (
            <Badge variant="success" icon={true}>
              Verified
            </Badge>
          )}
          {productState.state === "blocked" && (
            <Badge variant="error" icon={true}>
              Blocked
            </Badge>
          )}
          {productState.state === "cancelled" && (
            <Badge variant="incomplete" icon={true}>
              Cancelled
            </Badge>
          )}
        </div>
      </div>

      {showSaveNotice ? (
        <div
          role="status"
          aria-live="polite"
          className="border-b border-success/20 bg-success-soft px-4 py-1.5 text-xs text-success"
        >
          Saved locally — this Java draft stays on your device.
        </div>
      ) : null}

      {showVerificationNotice && verificationNoticeMessage ? (
        <div className="shrink-0 px-4 py-3 border-b border-line bg-bg-1/40 space-y-3">
          <ErrorNotice
            message={verificationNoticeMessage}
            failureCode={productState.failureCode ?? null}
          />
          {productState.state === "evidence-incomplete" ? (
            <MissingArtifactsPanel
              artifacts={productState.missingArtifacts || []}
            />
          ) : null}
          {productState.state === "hash-mismatch" &&
          productState.mismatchedHashes?.length ? (
            <div className="rounded border border-error/20 bg-error/5 px-4 py-3 text-xs text-text-dim">
              <div className="font-semibold text-error mb-2">
                Conflicting Artifact References
              </div>
              <ul className="space-y-2 font-mono">
                {productState.mismatchedHashes.map((mismatch) => (
                  <li key={`${mismatch.context}-${mismatch.actual}`}>
                    <div className="text-text">{mismatch.context}</div>
                    <div>expected: {mismatch.expected}</div>
                    <div>actual: {mismatch.actual}</div>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="flex-1 overflow-auto bg-bg-0">
        {isFetchingFile ? (
          <div
            className="flex h-full items-center justify-center text-text-dim"
            role="status"
            aria-live="polite"
          >
            <Loader2 className="animate-spin text-accent mr-2" size={16} />
            <span>Loading file content...</span>
          </div>
        ) : fileFetchError ? (
          <div className="flex h-full items-center justify-center p-6 text-center text-error">
            <p>Failed to load file: {fileFetchError.message}</p>
          </div>
        ) : !selectedFilePath ? (
          <div className="flex h-full items-center justify-center p-6 text-center text-text-dim">
            <p>
              Select a file from the Java Project Explorer to view its content.
            </p>
          </div>
        ) : unavailableFiles.has(selectedFilePath) ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-text-dim">
            <BlockedState
              reason="Generated file unavailable"
              details="The BFF listed this generated Java file, but its content endpoint did not return the artifact. Verified state cannot be claimed from missing content."
            />
            <MissingArtifactsPanel artifacts={[selectedFilePath]} />
          </div>
        ) : displayedContent === null ? (
          <div className="flex h-full items-center justify-center p-6 text-center text-text-dim">
            <p>File content is empty or unavailable.</p>
          </div>
        ) : (
          <VirtualizedCodeBlock
            code={displayedContent}
            label={`Generated Java source for ${selectedFilePath}`}
            data-file-path={selectedFilePath}
            data-file-sha256={selectedFileRef?.sha256}
            data-artifact-sha256={artifactDetails?.sha256}
          />
        )}
      </div>

      {conflictForThisFile ? (
        <ConflictResolverDialog
          kind="java"
          filePath={conflictForThisFile.filePath}
          panels={conflictPanels}
          onChoose={resolveJavaConflict}
          onDismiss={dismissJavaConflict}
        />
      ) : null}
    </div>
  );
}

function JavaStatusChips({
  clean,
  pendingReRun,
  staleJava,
}: {
  clean: boolean;
  pendingReRun: boolean;
  staleJava: boolean;
}) {
  if (!clean && !pendingReRun && !staleJava) {
    return null;
  }
  return (
    <span className="flex items-center gap-1" data-testid="java-status-chips">
      {clean ? (
        <span className="inline-flex items-center rounded bg-success-soft px-2 py-0.5 text-[10px] font-medium text-success border border-success/20">
          clean
        </span>
      ) : null}
      {pendingReRun ? (
        <span className="inline-flex items-center rounded bg-warn-soft px-2 py-0.5 text-[10px] font-medium text-warn border border-warn/20">
          pending re-run
        </span>
      ) : null}
      {staleJava ? (
        <span className="inline-flex items-center rounded bg-orange-soft px-2 py-0.5 text-[10px] font-medium text-orange border border-orange/20">
          stale java
        </span>
      ) : null}
    </span>
  );
}
