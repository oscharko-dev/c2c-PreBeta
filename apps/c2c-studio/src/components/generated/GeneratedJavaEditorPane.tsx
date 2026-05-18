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
import {
  useEditorMarkerRegistration,
  useMarkerNavigation,
} from "@/lib/editor/markerNavigation";
import { useMonacoReady } from "@/lib/editor/lazyMonaco";
import type { EditorMarkerGroup } from "@/components/editor/codeEditorTypes";
import { formatJava } from "@/lib/editor/javaFormatClient";
import { JAVA_LINT_OWNER, lintJava } from "@/lib/editor/javaLint";
import {
  getJavaFormatOnSave,
  setJavaFormatOnSave,
} from "@/lib/editor/javaFormatOnSave";
import { compileCheck } from "@/lib/editor/compileCheckClient";
import {
  useJavaEditorActions,
  useRegisterCompileCheckHandler,
} from "@/stores/javaEditorActions";
import type { Diagnostic, JavaOriginRegion } from "@/types/api";
import { useOriginOverlayApi, useOverlay } from "@/lib/editor/originOverlay";
import { useLineageCoverageApi } from "@/stores/lineageCoverage";
import {
  fetchTraceability,
  TraceabilityNotFoundError,
} from "@/lib/editor/traceParser";
import { resolveJavaToCobol } from "@/lib/editor/lineageNavigation";
import {
  buildTrustPillarDecorations,
  lineageCoveragePct,
  mergeRegionsForTrustPillars,
} from "@/lib/editor/trustPillars";
// Studio-IDE-13 (#255): manual-edit overlay computation and 3-Way Merge
// dialog wiring. The overlay is recomputed on every debounced buffer
// change so trust-pillar decorations and the manual-edits chip stay in
// sync within the 500 ms AC budget.
import { computeManualEditOverlay } from "@/lib/editor/manualEditOverlay";
import {
  defaultRegionId,
  type ConflictRegionResolution,
} from "@/lib/editor/conflictDetection";
import {
  ThreeWayMergeDialog,
  type MergeChoice,
} from "@/components/diff/ThreeWayMergeDialog";
// Studio-IDE-7 (#252): synchronized Java + COBOL diff workspace.
import { DiffWorkspace } from "@/components/diff/DiffWorkspace";
import { deriveSourceHash } from "@/lib/sourceAnalysis";

// Studio-IDE-6 (#248): synthetic Monaco marker owner for lineage-jump
// feedback (e.g. "lineage stale due to manual edit"). Kept distinct from
// the diagnostic owners so clearing it never wipes real diagnostics.
const LINEAGE_FEEDBACK_OWNER = "c2c-lineage-feedback" as const;

// Studio-IDE-6 (#248): a custom DOM event the Java pane dispatches when
// the user invokes Alt+J on a region with valid lineage. The COBOL pane
// listens for this and reveals the target line. Decoupling via window
// events avoids prop-drilling and keeps the two panes loosely coupled.
export interface RevealCobolDetail {
  cobolFile: string;
  cobolLine: number;
}
const REVEAL_COBOL_EVENT = "c2c:reveal-cobol";

const SAVE_NOTICE_VISIBLE_MS = 2500;
const FORMAT_NOTICE_VISIBLE_MS = 4000;
// Studio-IDE-4 (#245): keystroke-to-buffer-model debounce. 500 ms matches
// the COBOL editor cadence (Studio-IDE-2) so the chip / status derivation
// has identical responsiveness across the two editors.
const JAVA_BUFFER_DEBOUNCE_MS = 500;
// Studio-IDE-14 (#256): lint cadence. 300 ms matches the slice contract;
// shorter intervals risk flooding the Problems panel mid-keystroke.
const JAVA_LINT_DEBOUNCE_MS = 300;
const SHA_CHIP_LENGTH = 12;
const JAVA_BUILD_OWNER = "c2c-java-build" as const;

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
    selectFile,
  } = useGeneratedArtifacts();

  const {
    state,
    productState,
    javaBuffers,
    javaConflict,
    saveNoticeAt,
    ensureJavaBaseline,
    setJavaBufferContent,
    setJavaManualOverlay,
    saveJavaDraft,
    loadJavaDraftFor,
    resolveJavaConflict,
    dismissJavaConflict,
    javaStatusFlags,
    javaMergeReview,
    requestJavaMergeReview,
    applyJavaMergeSelections,
    cancelJavaMergeReview,
    javaDiffHistory,
    cobolDiffHistory,
    recordJavaDiffSnapshot,
  } = useTransformationRun();

  // Studio-IDE-6 (#248): origin-overlay + lineage-coverage wiring. The
  // overlay context (shared with IDE-4/IDE-13) holds per-(runId, javaFile)
  // region overlays; we publish trust-pillar overlays here. Coverage is a
  // separate sibling store the StatusBar reads from.
  const overlayApi = useOriginOverlayApi();
  const lineageCoverageApi = useLineageCoverageApi();
  const overlay = useOverlay(state.runId ?? null, selectedFilePath ?? null);

  const [showSaveNotice, setShowSaveNotice] = useState(false);
  // Studio-IDE-7 (#252): Compare Runs overlay open/close state.
  const [showDiffWorkspace, setShowDiffWorkspace] = useState(false);
  // Studio-IDE-14 (#256): lint state, compile-check diagnostics, and the
  // transient format toast are hoisted up here so the auto-dismiss effect
  // below can subscribe to `formatNotice` before the rest of the component
  // is fully built up. Keep the declarations together so the file stays
  // navigable.
  const [lintDiagnostics, setLintDiagnostics] = useState<Diagnostic[]>([]);
  const [compileCheckDiagnostics, setCompileCheckDiagnostics] = useState<
    Diagnostic[]
  >([]);
  const [formatNotice, setFormatNotice] = useState<{
    tone: "info" | "warning" | "error";
    message: string;
  } | null>(null);
  const [formatOnSave, setFormatOnSaveState] = useState<boolean>(false);
  useEffect(() => {
    setFormatOnSaveState(getJavaFormatOnSave());
  }, []);
  const handleFormatOnSaveToggle = useCallback(() => {
    setFormatOnSaveState((previous) => {
      const next = !previous;
      setJavaFormatOnSave(next);
      return next;
    });
  }, []);

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

  // Studio-IDE-7 (#252): record this run's Java content into the diff
  // history accumulator the moment the BFF delivers it. The accumulator
  // is a no-op for repeat polls of the same (sourceKey, filePath, runId)
  // triple, so the effect can safely fire on every fileContent change
  // without disturbing the "previous" snapshot. We key by programId
  // because the BFF's traceability + run identity contract uses it as
  // the canonical sourceKey (ADR-0007 §3).
  useEffect(() => {
    if (
      !selectedFilePath ||
      fileContent === null ||
      !state.runId ||
      !state.programId ||
      isFetchingFile
    ) {
      return;
    }
    const programId = state.programId;
    const runId = state.runId;
    const filePath = selectedFilePath;
    const content = fileContent;
    void deriveSourceHash(content).then((hash) => {
      recordJavaDiffSnapshot(programId, filePath, {
        content,
        sourceHash: hash,
        runId,
      });
    });
  }, [
    selectedFilePath,
    fileContent,
    state.runId,
    state.programId,
    isFetchingFile,
    recordJavaDiffSnapshot,
  ]);

  // Studio-IDE-13 (#255) AC3: when a new generator run lands while the
  // current Java buffer holds manual edits, open the 3-Way Merge dialog
  // instead of silently keeping the old (dirty) buffer. The check fires
  // when (a) the BFF-delivered file content arrives for the current run,
  // (b) the existing buffer is dirty (i.e., diverges from its previous
  // generator baseline), and (c) the new generator output differs from
  // the current buffer. The merge review is keyed by (filePath, runId)
  // so it does not re-trigger on every poll for the same content.
  const lastMergeReviewKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (
      !selectedFilePath ||
      fileContent === null ||
      !state.runId ||
      isFetchingFile
    ) {
      return;
    }
    const entry = javaBuffers[selectedFilePath];
    if (!entry) return;
    if (!entry.isDirty) return;
    // The buffer is dirty AND a fresh run is in scope. Skip if the run
    // that produced the buffer is the same as the current run (no new
    // generator output to compare against).
    if (entry.generatorBaselineRunId === state.runId) return;
    if (fileContent === entry.content) return;
    const key = `${state.runId}::${selectedFilePath}`;
    if (lastMergeReviewKeyRef.current === key) return;
    lastMergeReviewKeyRef.current = key;
    requestJavaMergeReview({
      filePath: selectedFilePath,
      baselineContent: entry.generatorBaselineContent,
      manualContent: entry.content,
      newGeneratorContent: fileContent,
      newGeneratorRunId: state.runId,
    });
  }, [
    selectedFilePath,
    fileContent,
    state.runId,
    isFetchingFile,
    javaBuffers,
    requestJavaMergeReview,
  ]);

  // Studio-IDE-13 (#255) AC8: recompute the manual-edit overlay on
  // every buffer change. The 500 ms debounce on ``setJavaBufferContent``
  // already gates this effect, so trust-pillar decorations and the
  // overlay propagation stay within the AC budget. The overlay is
  // persisted on the buffer entry (so editorPersistence round-trips it
  // through IndexedDB) and merged with the traceability overlay at
  // decoration time below — we deliberately do NOT call
  // ``overlayApi.setOverlay`` here because that path is owned by the
  // traceability fetch and would clobber its trust-pillar regions.
  useEffect(() => {
    if (!selectedFilePath || !state.runId) return;
    const entry = javaBuffers[selectedFilePath];
    if (!entry) return;
    const computed = computeManualEditOverlay({
      baselineContent: entry.generatorBaselineContent,
      currentContent: entry.content,
      runId: state.runId,
      javaFile: selectedFilePath,
      generatorBaselineRunId: entry.generatorBaselineRunId,
    });
    // Only push if the overlay actually changed; otherwise the effect
    // would loop forever through the javaBuffers dep.
    const prev = entry.manualEditOverlay;
    const same =
      (prev === null && computed === null) ||
      (prev !== null &&
        computed !== null &&
        prev.regions.length === computed.regions.length &&
        prev.regions.every((r, i) => {
          const c = computed.regions[i]!;
          return (
            r.originClass === c.originClass &&
            r.lineRange.startLine === c.lineRange.startLine &&
            r.lineRange.endLine === c.lineRange.endLine
          );
        }));
    if (same) return;
    setJavaManualOverlay(selectedFilePath, computed);
  }, [selectedFilePath, state.runId, javaBuffers, setJavaManualOverlay]);

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

  // Studio-IDE-14 (#256): format / compile-check notice auto-dismiss.
  useEffect(() => {
    if (formatNotice === null) return;
    const handle = setTimeout(
      () => setFormatNotice(null),
      FORMAT_NOTICE_VISIBLE_MS,
    );
    return () => clearTimeout(handle);
  }, [formatNotice]);

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
    : {
        clean: false,
        pendingReRun: false,
        staleJava: false,
        manualEditsPresent: false,
      };
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
  // Studio-IDE-5 (#244 review): bump this counter when the editor
  // mounts so the marker memo recomputes with the live Monaco model
  // (resolving whole-line marker geometry).
  const [editorMountToken, setEditorMountToken] = useState(0);
  const { registerOnMount: registerMarkerEditor } = useEditorMarkerRegistration(
    {
      id: "generated-java-editor",
      filePath: selectedFilePath ?? null,
    },
  );
  // Studio-IDE-5 (#244 review): the marker memo depends on Monaco
  // having resolved. `useMonacoReady` returns null until the async
  // loader completes, then re-renders so the memo recomputes with the
  // real instance. Without this, a cold mount with diagnostics already
  // in state would cache an empty marker group permanently.
  const monaco = useMonacoReady();

  // Studio-IDE-5 (#244 review): when Problems-panel clicks point at a
  // generated file that is not currently selected, switch panes. The
  // `target` token bumps on every dispatch, so we react to it even
  // when the same filePath arrives twice. We MUST guard against
  // non-generated targets (e.g. a click on a COBOL diagnostic) —
  // otherwise this effect would try to fetch a non-existent generated
  // file and leave the pane on a broken selection.
  const { target: navigationTarget } = useMarkerNavigation();
  // Track the navigation token so a second effect can complete the
  // focus jump AFTER the file becomes selected (the editor model has
  // to be attached to the new file before revealLineInCenter is
  // useful).
  const pendingTokenRef = useRef<number | null>(null);
  useEffect(() => {
    if (!navigationTarget) return;
    const targetPath = navigationTarget.filePath;
    if (!targetPath) return;
    if (targetPath === selectedFilePath) {
      // Same file — let the navigation context's focusEditor handle
      // the line jump on the registered editor.
      return;
    }
    const generatedPaths = state.generatedFiles?.files ?? [];
    // Path-segment suffix match against the list of generated files —
    // the BFF normalizes javac absolute paths but we match defensively
    // against both forms.
    const matched = generatedPaths.find((file) => {
      if (file.path === targetPath) return true;
      const a = file.path.split(/[\\/]+/).filter(Boolean);
      const b = targetPath.split(/[\\/]+/).filter(Boolean);
      if (a.length === 0 || b.length === 0) return false;
      const short = a.length < b.length ? a : b;
      const long = a.length < b.length ? b : a;
      for (let i = 0; i < short.length; i += 1) {
        if (short[short.length - 1 - i] !== long[long.length - 1 - i]) {
          return false;
        }
      }
      return true;
    });
    if (!matched) return;
    pendingTokenRef.current = navigationTarget.token;
    selectFile(matched.path);
  }, [
    navigationTarget,
    selectedFilePath,
    selectFile,
    state.generatedFiles?.files,
  ]);

  // Studio-IDE-5 (#244 review): complete the jump once the editor has
  // mounted with the freshly-selected file. We compare tokens so a
  // stale target (from an earlier click) does not race ahead of the
  // current selection.
  useEffect(() => {
    if (!navigationTarget) return;
    if (pendingTokenRef.current !== navigationTarget.token) return;
    if (navigationTarget.filePath !== selectedFilePath) return;
    if (!editorInstanceRef.current) return;
    const targetLine = Math.max(1, navigationTarget.line);
    const targetColumn = Math.max(1, navigationTarget.column ?? 1);
    editorInstanceRef.current.revealLineInCenterIfOutsideViewport(targetLine);
    editorInstanceRef.current.setPosition({
      lineNumber: targetLine,
      column: targetColumn,
    });
    editorInstanceRef.current.focus();
    pendingTokenRef.current = null;
  }, [navigationTarget, selectedFilePath, editorMountToken]);

  const javaMarkerGroups: EditorMarkerGroup[] = useMemo(() => {
    if (!monaco) return [];
    const diagnostics = [
      ...(state.generated?.diagnostics ?? []),
      ...(state.buildTest?.diagnostics ?? []),
    ];
    const buckets = partitionByOwner(diagnostics);
    const model = editorInstanceRef.current?.getModel() ?? null;
    const groups: EditorMarkerGroup[] = [];
    // Studio-IDE-5 (#244 review): share the marker cap across owners
    // so the editor's total marker count never exceeds
    // DEFAULT_MARKER_LIMIT. Without a shared budget, three owners
    // could each emit 2000 markers — three times the advertised cap.
    let remaining = DEFAULT_MARKER_LIMIT;
    const segmentsMatch = (a: string, b: string): boolean => {
      const aParts = a.split(/[\\/]+/).filter(Boolean);
      const bParts = b.split(/[\\/]+/).filter(Boolean);
      if (aParts.length === 0 || bParts.length === 0) return false;
      const short = aParts.length < bParts.length ? aParts : bParts;
      const long = aParts.length < bParts.length ? bParts : aParts;
      for (let i = 0; i < short.length; i += 1) {
        if (short[short.length - 1 - i] !== long[long.length - 1 - i]) {
          return false;
        }
      }
      return true;
    };
    for (const owner of [
      "c2c-generated-java",
      "c2c-build",
      "c2c-test",
    ] as const) {
      const bucketDiagnostics = buckets[owner];
      const matchingFile = bucketDiagnostics.filter((d) => {
        if (!d.filePath) return false;
        if (!selectedFilePath) return false;
        return (
          d.filePath === selectedFilePath ||
          segmentsMatch(d.filePath, selectedFilePath)
        );
      });
      const { markers } = diagnosticsToMarkers(matchingFile, {
        monaco,
        model,
        limit: remaining,
      });
      remaining = Math.max(0, remaining - markers.length);
      groups.push({ owner, markers });
    }
    // Studio-IDE-14 (#256): client-side lint markers live in their own
    // owner so toggling the editor's "Clear lint" or repainting from a
    // Compile Check pass never erases the other groups.
    if (selectedFilePath && lintDiagnostics.length > 0) {
      const { markers: lintMarkers } = diagnosticsToMarkers(lintDiagnostics, {
        monaco,
        model,
        limit: remaining,
      });
      remaining = Math.max(0, remaining - lintMarkers.length);
      groups.push({ owner: JAVA_LINT_OWNER, markers: lintMarkers });
    }
    // Studio-IDE-14 (#256): Compile Check diagnostics. Owner is
    // `c2c-java-build` per the slice contract so it lives alongside the
    // existing `c2c-build` (workflow-run build) channel without
    // overwriting it.
    if (selectedFilePath && compileCheckDiagnostics.length > 0) {
      const buildScoped = compileCheckDiagnostics.filter((d) => {
        if (!d.filePath) return true;
        return (
          d.filePath === selectedFilePath ||
          segmentsMatch(d.filePath, selectedFilePath)
        );
      });
      const { markers: buildMarkers } = diagnosticsToMarkers(buildScoped, {
        monaco,
        model,
        limit: remaining,
      });
      remaining = Math.max(0, remaining - buildMarkers.length);
      groups.push({ owner: JAVA_BUILD_OWNER, markers: buildMarkers });
    }
    return groups;
    // editorMountToken is intentional — see review #244 round 3.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    monaco,
    state.generated,
    state.buildTest,
    selectedFilePath,
    editorMountToken,
    lintDiagnostics,
    compileCheckDiagnostics,
  ]);

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
  // Studio-IDE-6 (#248): ref-based capture of runId so the Alt+J action
  // closure always sees the current runId without re-mounting the command
  // on every state change.
  const stateRunIdRef = useRef(state.runId);
  stateRunIdRef.current = state.runId;
  const flushPendingEditRef = useRef(flushPendingEdit);
  flushPendingEditRef.current = flushPendingEdit;
  const formatOnSaveRef = useRef(formatOnSave);
  formatOnSaveRef.current = formatOnSave;
  const lintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const formatInFlightRef = useRef(false);

  // Studio-IDE-14 (#256): debounced lint. 300 ms after the last keystroke
  // we re-run the static rules; the markers refresh under the
  // `c2c-java-lint` owner via the marker memo above. Lint never mutates
  // the buffer.
  useEffect(() => {
    if (!selectedFilePath || displayedContent === null) {
      setLintDiagnostics([]);
      return;
    }
    if (lintTimerRef.current !== null) {
      clearTimeout(lintTimerRef.current);
    }
    const filePath = selectedFilePath;
    const content = displayedContent;
    lintTimerRef.current = setTimeout(() => {
      lintTimerRef.current = null;
      const next = lintJava(content, { filePath });
      setLintDiagnostics(next);
    }, JAVA_LINT_DEBOUNCE_MS);
    return () => {
      if (lintTimerRef.current !== null) {
        clearTimeout(lintTimerRef.current);
        lintTimerRef.current = null;
      }
    };
  }, [selectedFilePath, displayedContent]);

  // Studio-IDE-6 (#248): fetch the BFF traceability envelope when the
  // active run or selected Java file changes, then publish the regions
  // for the active file through OriginOverlayProvider so the decoration
  // effect below can paint trust pillars. Failures are intentionally
  // silent — the editor still works without the overlay; absence is
  // surfaced through the StatusBar's "Lineage: —" state.
  useEffect(() => {
    const runId = state.runId;
    const javaFile = selectedFilePath;
    if (!runId || !javaFile) return;
    let cancelled = false;
    void fetchTraceability(runId).then(
      (trace) => {
        if (cancelled) return;
        const regions = trace.javaRegionClassification.get(javaFile) ?? [];
        overlayApi.setOverlay(runId, javaFile, {
          schemaVersion: "v0",
          runId,
          javaFile,
          regions: regions.map<JavaOriginRegion>((r) => ({
            lineRange: r.lineRange,
            originClass: r.originClass,
            verificationOutcome: r.verificationOutcome,
            mappingClass: r.mappingClass,
          })),
        });
      },
      (err: unknown) => {
        if (cancelled) return;
        if (err instanceof TraceabilityNotFoundError) {
          overlayApi.setOverlay(runId, javaFile, null);
        }
        // Other errors: leave any prior overlay in place (likely stale
        // but better than wiping a working state for transient failures).
      },
    );
    return () => {
      cancelled = true;
    };
  }, [state.runId, selectedFilePath, overlayApi]);

  // Studio-IDE-6 (#248): paint trust-pillar decorations and publish the
  // file-level lineage-coverage percentage whenever the overlay or file
  // changes. Manual regions count as non-covered per the issue spec.
  const decorationCollectionRef = useRef<
    import("monaco-editor").editor.IEditorDecorationsCollection | null
  >(null);
  useEffect(() => {
    const editor = editorInstanceRef.current;
    const monacoGlobal = (
      window as unknown as { monaco?: typeof import("monaco-editor") }
    ).monaco;
    if (!editor) return;
    // Studio-IDE-13 (#255) AC8: union the trust-pillar overlay
    // (deterministic / agent_proposed / repair_attempted from the
    // traceability fetch) with the manual-edit overlay (manual_modified
    // / manual_edit from local diff) so manual regions render in purple
    // / orange per the issue spec. Manual regions synthesize a
    // ``no_oracle`` verification outcome and ``synthesized`` mapping
    // class so they pass the trust-pillar painter's type filter (which
    // requires both fields to be present); this is consistent with
    // ADR-0007 §6 which states manual lineage is stale or unavailable
    // and therefore cannot carry a real verification outcome.
    const combined = mergeRegionsForTrustPillars({
      traceabilityOverlay: overlay ?? null,
      manualOverlay: javaBufferEntry?.manualEditOverlay ?? null,
    });
    if (monacoGlobal && combined.length > 0) {
      const repairCount =
        state.workflow?.repairAttempts?.filter(
          (a) => a.repairDecision === "propose_candidate",
        ).length ?? 0;
      const decorations = buildTrustPillarDecorations({
        monaco: monacoGlobal,
        regions: combined,
        repairCount,
      });
      if (decorationCollectionRef.current) {
        decorationCollectionRef.current.set(decorations);
      } else {
        decorationCollectionRef.current =
          editor.createDecorationsCollection(decorations);
      }
    } else if (decorationCollectionRef.current) {
      decorationCollectionRef.current.clear();
    }
    // Coverage: derive from the model line count (truthier than the
    // raw fileContent because the user may be mid-edit).
    const model = editor.getModel();
    const totalLines = model?.getLineCount() ?? 0;
    if (selectedFilePath && totalLines > 0) {
      lineageCoverageApi.publish({
        filePath: selectedFilePath,
        pct: lineageCoveragePct(totalLines, combined),
      });
    } else {
      lineageCoverageApi.publish(null);
    }
  }, [
    overlay,
    javaBufferEntry?.manualEditOverlay,
    selectedFilePath,
    state.workflow,
    lineageCoverageApi,
    editorMountToken,
  ]);

  // Studio-IDE-14 (#256): replace the editor buffer with the supplied
  // content as a single atomic edit so the format is one undo step. The
  // function also re-seeds the buffer model via `setJavaBufferContent`
  // so the provenance overlay recomputes per ADR-4 (a format is a manual
  // edit unless the content is byte-identical).
  const applyFormattedContent = useCallback(
    (filePath: string, formatted: string) => {
      const editor = editorInstanceRef.current;
      if (!editor) return;
      const model = editor.getModel();
      if (!model) return;
      const current = model.getValue();
      if (current === formatted) {
        // Idempotent — nothing to apply, no provenance recompute needed.
        return;
      }
      const fullRange = model.getFullModelRange();
      editor.executeEdits("c2c.format-java", [
        {
          range: fullRange,
          text: formatted,
          forceMoveMarkers: true,
        },
      ]);
      pendingEditRef.current = null;
      if (debounceTimerRef.current !== null) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      setJavaBufferContent(filePath, formatted);
    },
    [setJavaBufferContent],
  );

  // Studio-IDE-14 (#256): the Cmd/Ctrl+Shift+F handler. Reused by the
  // format-on-save path on Cmd/Ctrl+S.
  const performFormat = useCallback(async (): Promise<boolean> => {
    const editor = editorInstanceRef.current;
    if (!editor || formatInFlightRef.current) return false;
    const model = editor.getModel();
    if (!model) return false;
    const filePath = selectedFilePathRef.current;
    if (!filePath) return false;
    flushPendingEditRef.current();
    const content = model.getValue();
    formatInFlightRef.current = true;
    try {
      const result = await formatJava({ content, filePath });
      if (!result.ok) {
        setFormatNotice({
          tone: result.code === "format_parse_error" ? "warning" : "error",
          message:
            result.code === "format_parse_error"
              ? `Could not format: ${result.message}`
              : `Formatter unavailable — buffer unchanged. ${result.message}`,
        });
        return false;
      }
      applyFormattedContent(filePath, result.formattedContent);
      return true;
    } finally {
      formatInFlightRef.current = false;
    }
  }, [applyFormattedContent]);

  const performFormatRef = useRef(performFormat);
  performFormatRef.current = performFormat;

  // Studio-IDE-14 (#256): Compile Check handler. Sends the current Java
  // buffer to `POST /api/v0/compile-check` (owned by Studio-IDE-13) and
  // surfaces the response as build-flavoured markers. A 404 / 5xx degrades
  // gracefully to a toast.
  const javaActions = useJavaEditorActions();
  const compileCheckPending = javaActions.compileCheckPending;
  const setCompileCheckPending = javaActions.setCompileCheckPending;
  const performCompileCheck = useCallback(async (): Promise<void> => {
    const editor = editorInstanceRef.current;
    const filePath = selectedFilePathRef.current;
    if (!editor || !filePath) return;
    const model = editor.getModel();
    if (!model) return;
    flushPendingEditRef.current();
    setCompileCheckPending(true);
    try {
      const result = await compileCheck({
        content: model.getValue(),
        filePath,
        ...(state.runId ? { runId: state.runId } : {}),
      });
      if (!result.ok) {
        setFormatNotice({
          tone: "error",
          message: `Compile Check unavailable — ${result.message}`,
        });
        setCompileCheckDiagnostics([]);
        return;
      }
      setCompileCheckDiagnostics(
        result.diagnostics.map((d) => ({
          ...d,
          // Re-anchor the diagnostic to the current file when the
          // upstream did not provide one.
          filePath: d.filePath ?? filePath,
          sourceKind: d.sourceKind ?? "build",
        })),
      );
      if (result.diagnostics.length === 0) {
        setFormatNotice({
          tone: "info",
          message: "Compile Check passed — no diagnostics reported.",
        });
      }
    } finally {
      setCompileCheckPending(false);
    }
  }, [setCompileCheckPending, state.runId]);

  useRegisterCompileCheckHandler(performCompileCheck);

  const performCompileCheckRef = useRef(performCompileCheck);
  performCompileCheckRef.current = performCompileCheck;

  const handleEditorMount = useCallback(
    ({ editor, monaco }: StandaloneEditorMountArgs) => {
      editorInstanceRef.current = editor;
      registerMarkerEditor(editor);
      // Bump the mount token so the marker memo recomputes with the
      // live model — without this, whole-line markers stay narrowed
      // to a single character.
      setEditorMountToken((value) => value + 1);
      // Cmd/Ctrl+S — local save, with opt-in format-on-save.
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
        flushPendingEditRef.current();
        const filePath = selectedFilePathRef.current;
        if (!filePath) return;
        if (formatOnSaveRef.current) {
          void performFormatRef.current().then(() => {
            void saveJavaDraftRef.current(filePath);
          });
        } else {
          void saveJavaDraftRef.current(filePath);
        }
      });
      // Cmd/Ctrl+Shift+F — Studio-IDE-14 format action.
      editor.addAction({
        id: "c2c.format-java",
        label: "Format Document (Java)",
        keybindings: [
          monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyF,
        ],
        contextMenuGroupId: "1_modification",
        contextMenuOrder: 1,
        run: () => {
          void performFormatRef.current();
        },
      });
      // F5 — Studio-IDE-14 Compile Check (Studio-IDE-13 endpoint).
      editor.addCommand(monaco.KeyCode.F5, () => {
        void performCompileCheckRef.current();
      });
      // Studio-IDE-6 (#248): Alt+J — "Reveal in COBOL source". Resolves the
      // Java→COBOL lineage for the cursor line and dispatches a window event
      // the COBOL pane listens to. Failures surface as info markers on the
      // line so the user knows *why* the jump was not possible.
      editor.addAction({
        id: "c2c.lineage.javaToCobol",
        label: "Reveal in COBOL source",
        keybindings: [monaco.KeyMod.Alt | monaco.KeyCode.KeyJ],
        contextMenuGroupId: "navigation",
        contextMenuOrder: 1.5,
        run: async (ed) => {
          const runId = stateRunIdRef.current;
          const javaFile = selectedFilePathRef.current;
          const model = ed.getModel();
          if (!runId || !javaFile || !model) return;
          const position = ed.getPosition();
          if (!position) return;
          const result = await resolveJavaToCobol(
            runId,
            javaFile,
            position.lineNumber,
            model.getValue(),
          );
          if (result.ok) {
            monaco.editor.setModelMarkers(model, LINEAGE_FEEDBACK_OWNER, []);
            window.dispatchEvent(
              new CustomEvent<RevealCobolDetail>(REVEAL_COBOL_EVENT, {
                detail: {
                  cobolFile: result.target.cobolFile,
                  cobolLine: result.target.cobolLine,
                },
              }),
            );
          } else {
            // Studio-IDE-6 (#248 AC6/AC7/AC9): tooltip strings are part of
            // the acceptance contract and must match the issue spec verbatim.
            const message =
              result.reason === "stale_manual_edit"
                ? "Lineage stale due to manual edit"
                : result.reason === "manual_only"
                  ? "Region did not exist in Generator Baseline; no COBOL lineage"
                  : "No source mapping available for this line";
            monaco.editor.setModelMarkers(model, LINEAGE_FEEDBACK_OWNER, [
              {
                severity: monaco.MarkerSeverity.Info,
                message,
                startLineNumber: position.lineNumber,
                endLineNumber: position.lineNumber,
                startColumn: 1,
                endColumn: model.getLineMaxColumn(position.lineNumber),
                source: "c2c-lineage",
              },
            ]);
          }
        },
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
            manualEditsPresent={flags.manualEditsPresent}
          />
        </div>
        <div className="flex gap-2 items-center">
          {isJavaEditable && selectedFilePath ? (
            <label
              data-testid="java-format-on-save-toggle"
              className="flex items-center gap-1 text-[10px] text-text-dim select-none cursor-pointer"
              title="Format Java on Save (Cmd/Ctrl+S)"
            >
              <input
                type="checkbox"
                checked={formatOnSave}
                onChange={handleFormatOnSaveToggle}
                aria-label="Format Java on Save"
                className="h-3 w-3"
              />
              <span>Format on Save</span>
            </label>
          ) : null}
          {isJavaEditable && selectedFilePath ? (
            <button
              type="button"
              onClick={() => void performFormat()}
              data-testid="java-format-button"
              title="Format Document (Cmd/Ctrl+Shift+F)"
              aria-label="Format Java document"
              className="rounded border border-line px-2 py-0.5 text-[10px] font-medium text-text-dim hover:bg-bg-2 disabled:opacity-50 disabled:cursor-not-allowed"
              disabled={formatInFlightRef.current}
            >
              Format
            </button>
          ) : null}
          {isJavaEditable && selectedFilePath ? (
            <button
              type="button"
              onClick={() => void performCompileCheck()}
              data-testid="java-compile-check-pane-button"
              title="Compile Check (F5)"
              aria-label="Run Compile Check on the Java buffer"
              className="rounded border border-line px-2 py-0.5 text-[10px] font-medium text-text-dim hover:bg-bg-2 disabled:opacity-50 disabled:cursor-not-allowed"
              disabled={compileCheckPending}
            >
              {compileCheckPending ? "Compile…" : "Compile Check"}
            </button>
          ) : null}
          {selectedFilePath && state.programId ? (
            <button
              type="button"
              onClick={() => setShowDiffWorkspace(true)}
              data-testid="java-compare-runs-button"
              title="Open the synchronized Java + COBOL diff for the previous run."
              aria-label="Compare runs"
              className="rounded border border-line px-2 py-0.5 text-[10px] font-medium text-text-dim hover:bg-bg-2"
            >
              Compare Runs
            </button>
          ) : null}
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

      {formatNotice ? (
        <div
          role="status"
          aria-live="polite"
          data-testid="java-format-notice"
          data-tone={formatNotice.tone}
          className={
            formatNotice.tone === "warning"
              ? "border-b border-warn/20 bg-warn-soft px-4 py-1.5 text-xs text-warn"
              : formatNotice.tone === "error"
                ? "border-b border-error/20 bg-error/10 px-4 py-1.5 text-xs text-error"
                : "border-b border-line bg-bg-1 px-4 py-1.5 text-xs text-text-dim"
          }
        >
          {formatNotice.message}
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

      {/*
       * Studio-IDE-13 (#255): 3-Way Merge dialog. Opens when a new
       * generator run lands while the buffer holds manual edits (per
       * AC3) or when the user explicitly invokes Generate / Regenerate
       * on a dirty buffer. Selections are keyed by the same
       * ``defaultRegionId`` the store uses to apply them back to the
       * buffer, so the round-trip is lossless.
       */}
      {javaMergeReview && javaMergeReview.filePath === selectedFilePath ? (
        <ThreeWayMergeDialog
          filePath={javaMergeReview.filePath}
          baselineContent={javaMergeReview.baselineContent}
          manualContent={javaMergeReview.manualContent}
          newGeneratorContent={javaMergeReview.newGeneratorContent}
          regions={javaMergeReview.regions.map((r) => ({
            id: defaultRegionId(r),
            lineRange: r.lineRange,
            conflictKind: r.conflictKind,
            baselineContent: r.baselineContent,
            manualContent: r.manualContent,
            newGeneratorContent: r.newGeneratorContent,
            suggestedResolution: r.suggestedResolution as MergeChoice | null,
            needsUserPick: r.needsUserPick,
          }))}
          onApply={(selections) => {
            // The dialog produces a Record<id, MergeChoice>; the store
            // accepts Record<id, ConflictRegionResolution> which has
            // the identical string union, so a direct cast is safe.
            void applyJavaMergeSelections(
              selections as Record<string, ConflictRegionResolution>,
            );
          }}
          onCancel={cancelJavaMergeReview}
        />
      ) : null}

      {/*
       * Studio-IDE-7 (#252): Compare Runs overlay. Opens on the toolbar
       * button click and pulls the previous→current snapshots for this
       * (programId, filePath) out of the in-memory diff history.
       * Empty / un-coupled states are handled internally by DiffWorkspace.
       */}
      {showDiffWorkspace &&
      selectedFilePath &&
      state.programId &&
      state.runId ? (
        <DiffWorkspace
          filePath={selectedFilePath}
          sourceKey={state.programId}
          runId={state.runId}
          javaHistory={javaDiffHistory[state.programId]?.[selectedFilePath]}
          cobolSnapshotsByRun={cobolDiffHistory[state.programId]}
          onClose={() => setShowDiffWorkspace(false)}
        />
      ) : null}
    </div>
  );
}

function JavaStatusChips({
  clean,
  pendingReRun,
  staleJava,
  manualEditsPresent,
}: {
  clean: boolean;
  pendingReRun: boolean;
  staleJava: boolean;
  manualEditsPresent: boolean;
}) {
  if (!clean && !pendingReRun && !staleJava && !manualEditsPresent) {
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
      {manualEditsPresent ? (
        <span
          data-testid="java-status-chip-manual-edits"
          title="The Java buffer diverges from the Generator Baseline."
          className="inline-flex items-center rounded bg-accent/10 px-2 py-0.5 text-[10px] font-medium text-accent border border-accent/30"
        >
          manual edits present
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
