"use client";

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Loader2 } from "lucide-react";

import { useGeneratedArtifacts } from "@/hooks/useGeneratedArtifacts";
import { UnsupportedConstructsPanel } from "@/components/state/UnsupportedConstructsPanel";
import { MissingArtifactsPanel } from "@/components/state/MissingArtifactsPanel";
import { BlockedState } from "@/components/state/BlockedState";
import { ErrorNotice } from "@/components/state/ErrorNotice";
import { Badge } from "@/components/ui/Badge";
import { useTransformationRun } from "@/stores/transformationRun";
import { CodeEditor } from "@/components/editor/CodeEditor";
import type { StandaloneEditorMountArgs } from "@/components/editor/CodeEditor";
import {
  detectLanguageFromPath,
  isEditableLanguage,
} from "@/lib/editor/languageDetection";
import {
  ConflictResolverDialog,
  type ConflictPanel,
} from "@/components/source/ConflictResolverDialog";
import {
  DEFAULT_MARKER_LIMIT,
  diagnosticsToMarkers,
  partitionByOwner,
} from "@/lib/editor/diagnosticMarkers";
import { useEditorMarkerRegistration } from "@/lib/editor/markerNavigation";
import { getMonacoSync } from "@/lib/editor/lazyMonaco";
import type { EditorMarkerGroup } from "@/components/editor/codeEditorTypes";

const SAVE_NOTICE_VISIBLE_MS = 2500;
// Studio-IDE-4 (#245): keystroke-to-buffer-model debounce. 500 ms matches
// the COBOL editor cadence (Studio-IDE-2) so the chip / status derivation
// has identical responsiveness across the two editors.
const JAVA_BUFFER_DEBOUNCE_MS = 500;
const SHA_CHIP_LENGTH = 12;

type RunMode = "deterministic" | "ai-assisted" | "stale";

function deriveRunMode(args: {
  staleJava: boolean;
  assistRequired: boolean;
  hasRepairAttempts: boolean;
}): RunMode {
  if (args.staleJava) {
    return "stale";
  }
  if (args.assistRequired || args.hasRepairAttempts) {
    return "ai-assisted";
  }
  return "deterministic";
}

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
    setJavaBufferContent,
    saveJavaDraft,
    loadJavaDraftFor,
    resolveJavaConflict,
    dismissJavaConflict,
    javaStatusFlags,
  } = useTransformationRun();

  const [showSaveNotice, setShowSaveNotice] = useState(false);

  // Hydrate the Java buffer for this (runId, filePath) when content lands.
  // Studio-IDE-3 (#247) seeded the buffer for status chips and conflict
  // resolution; Studio-IDE-4 (#245) now feeds user keystrokes back into the
  // same buffer model via the debounced onChange handler below.
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
  // When the Java buffer holds user edits (dirty or persisted draft), prefer
  // it over the BFF response so the editor reflects in-flight work.
  const displayedContent = javaBufferEntry?.isDirty
    ? javaBufferEntry.content
    : fileContent;

  const detectedLanguage = useMemo(
    () => detectLanguageFromPath(selectedFilePath),
    [selectedFilePath],
  );
  const isJavaEditable = isEditableLanguage(detectedLanguage);

  // Stable per-(runId, filePath) URI keeps Monaco's view-state map (cursor,
  // scroll, selection) in `modelLifecycle.ts` partitioned per file. When the
  // user toggles between files in the project explorer, the editor restores
  // each file's last view state automatically.
  const modelUri = useMemo(() => {
    if (!state.runId || !selectedFilePath) {
      return undefined;
    }
    return `inmemory://c2c-studio/generated/${state.runId}/${selectedFilePath}`;
  }, [state.runId, selectedFilePath]);

  // Studio-IDE-5 (#244): typed diagnostics that target the generated
  // Java pane (`sourceKind: generated_java | build | test`).
  // Diagnostics without a filePath route to the active file; ones with
  // a filePath that does not match the current selection appear in the
  // Problems panel but stay off the editor surface.
  const editorInstanceRef = useRef<
    import("monaco-editor").editor.IStandaloneCodeEditor | null
  >(null);
  const { registerOnMount: registerMarkerEditor } = useEditorMarkerRegistration({
    id: "generated-java-editor",
    filePath: selectedFilePath ?? null,
  });
  const javaMarkerGroups: EditorMarkerGroup[] = useMemo(() => {
    const diagnostics = [
      ...(state.generated?.diagnostics ?? []),
      ...(state.buildTest?.diagnostics ?? []),
    ];
    const monaco = getMonacoSync();
    if (!monaco) return [];
    const buckets = partitionByOwner(diagnostics);
    const model = editorInstanceRef.current?.getModel() ?? null;
    const groups: EditorMarkerGroup[] = [];
    for (const owner of ["c2c-generated-java", "c2c-build", "c2c-test"] as const) {
      const bucketDiagnostics = buckets[owner];
      const matchingFile = bucketDiagnostics.filter((d) => {
        if (!d.filePath) return true;
        if (!selectedFilePath) return false;
        return (
          d.filePath === selectedFilePath ||
          d.filePath.endsWith(selectedFilePath) ||
          selectedFilePath.endsWith(d.filePath)
        );
      });
      const { markers } = diagnosticsToMarkers(matchingFile, {
        monaco,
        model,
        limit: DEFAULT_MARKER_LIMIT,
      });
      groups.push({ owner, markers });
    }
    return groups;
  }, [state.generated, state.buildTest, selectedFilePath]);

  // Debounced onChange — schedules a single bufferModel update per
  // JAVA_BUFFER_DEBOUNCE_MS window. The handler captures the current
  // `selectedFilePath` at scheduling time so a mid-flight switch routes the
  // pending edit to the file the user was editing, never to the new file.
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingEditRef = useRef<{ filePath: string; content: string } | null>(
    null,
  );

  const flushPendingEdit = useCallback(() => {
    if (debounceTimerRef.current !== null) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    const pending = pendingEditRef.current;
    if (pending) {
      setJavaBufferContent(pending.filePath, pending.content);
      pendingEditRef.current = null;
    }
  }, [setJavaBufferContent]);

  // Flush any pending edit when (a) the active file changes — routing it to
  // the file the user actually typed in — and (b) the pane unmounts, so an
  // in-flight edit is not lost when the workbench tab changes. Both cases
  // are covered by this single cleanup: React runs it on every dep change
  // *and* on unmount.
  useEffect(() => {
    return () => {
      flushPendingEdit();
    };
  }, [selectedFilePath, flushPendingEdit]);

  const handleEditorChange = useCallback(
    (next: string) => {
      if (!selectedFilePath || !isJavaEditable) {
        return;
      }
      pendingEditRef.current = { filePath: selectedFilePath, content: next };
      if (debounceTimerRef.current !== null) {
        clearTimeout(debounceTimerRef.current);
      }
      debounceTimerRef.current = setTimeout(() => {
        const pending = pendingEditRef.current;
        debounceTimerRef.current = null;
        if (pending) {
          setJavaBufferContent(pending.filePath, pending.content);
          pendingEditRef.current = null;
        }
      }, JAVA_BUFFER_DEBOUNCE_MS);
    },
    [selectedFilePath, isJavaEditable, setJavaBufferContent],
  );

  // Save current draft on Cmd/Ctrl+S inside the editor surface. Monaco
  // intercepts the keystroke before the browser so this works even when the
  // editor has keyboard focus (the global shortcut hook ignores keydowns
  // there). Mirrors CobolEditorPane's wiring (Studio-IDE-2 #246).
  const saveJavaDraftRef = useRef(saveJavaDraft);
  saveJavaDraftRef.current = saveJavaDraft;
  const selectedFilePathRef = useRef(selectedFilePath);
  selectedFilePathRef.current = selectedFilePath;
  const flushPendingEditRef = useRef(flushPendingEdit);
  flushPendingEditRef.current = flushPendingEdit;

  const handleEditorMount = useCallback(
    ({ editor, monaco }: StandaloneEditorMountArgs) => {
      editorInstanceRef.current = editor;
      registerMarkerEditor(editor);
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
        // Make sure the last in-flight edit lands in the buffer model
        // before the persistence layer reads it.
        flushPendingEditRef.current();
        const filePath = selectedFilePathRef.current;
        if (filePath) {
          void saveJavaDraftRef.current(filePath);
        }
      });
    },
    [registerMarkerEditor],
  );

  // Run-mode badge (file level). Per #245 spec:
  //   Stale         — displayedArtifactSourceHash ≠ lastRunInputHash
  //   AI-Assisted   — assistDecision.outcome === 'assist_required' OR any
  //                   repair attempt occurred
  //   Deterministic — everything else (including assistDecision === null
  //                   for runs that have not yet reached the gate)
  const runMode: RunMode = useMemo(() => {
    const workflow = state.workflow;
    return deriveRunMode({
      staleJava: flags.staleJava,
      assistRequired: workflow?.assistDecision?.outcome === "assist_required",
      hasRepairAttempts: (workflow?.repairAttempts?.length ?? 0) > 0,
    });
  }, [state.workflow, flags.staleJava]);

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

  const fileSha = selectedFileRef?.sha256 ?? null;

  return (
    <div
      className="flex flex-col h-full overflow-hidden relative bg-bg-0"
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
        <div className="flex gap-2 items-center">
          {selectedFilePath ? <RunModeBadge mode={runMode} /> : null}
          {fileSha ? (
            <span
              data-testid="java-file-sha-chip"
              title={`File SHA-256 ${fileSha}`}
              className="inline-flex items-center rounded bg-bg-2 px-2 py-0.5 text-[10px] font-mono text-text-dim border border-line"
            >
              sha {fileSha.slice(0, SHA_CHIP_LENGTH)}
            </span>
          ) : null}
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

      <div
        className="flex-1 min-h-0 bg-bg-0"
        data-testid="generated-java-editor-surface"
        data-file-path={selectedFilePath ?? undefined}
        data-file-sha256={selectedFileRef?.sha256}
        data-artifact-sha256={artifactDetails?.sha256}
      >
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
          <CodeEditor
            mode={isJavaEditable ? "editable" : "readonly"}
            language={detectedLanguage}
            value={displayedContent}
            onChange={isJavaEditable ? handleEditorChange : undefined}
            onMount={isJavaEditable ? handleEditorMount : undefined}
            modelUri={modelUri}
            ariaLabel={`Generated Java source for ${selectedFilePath}`}
            markerGroups={javaMarkerGroups}
            className="h-full"
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

function RunModeBadge({ mode }: { mode: RunMode }) {
  const label =
    mode === "stale"
      ? "Stale"
      : mode === "ai-assisted"
        ? "AI-Assisted Run"
        : "Deterministic Run";
  const tone =
    mode === "stale"
      ? "border-orange/30 bg-orange-soft text-orange"
      : mode === "ai-assisted"
        ? "border-accent/30 bg-accent/10 text-accent"
        : "border-success/30 bg-success-soft text-success";
  const tooltip =
    mode === "stale"
      ? "The displayed Java source differs from the input that produced the last completed run."
      : mode === "ai-assisted"
        ? "An assist agent or repair pass contributed to this Java output."
        : "Generated by deterministic translation rules without assist or repair.";
  return (
    <span
      data-testid="java-run-mode-badge"
      data-run-mode={mode}
      title={tooltip}
      aria-label={`Run mode: ${label}`}
      className={`inline-flex items-center rounded border px-2 py-0.5 text-[10px] font-medium ${tone}`}
    >
      {label}
    </span>
  );
}
