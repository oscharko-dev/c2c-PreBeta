"use client";

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type * as MonacoNs from "monaco-editor";
import { Play } from "lucide-react";

import { useSourceWorkspace } from "@/stores/sourceWorkspace";
import {
  DEFAULT_SOURCE_NAME,
  deriveDetectedProgramId,
  deriveDisplayedLineEnding,
} from "@/lib/sourceAnalysis";
import { useC2cApi } from "@/hooks/useC2cApi";
import { useTransformationRun } from "@/stores/transformationRun";
import { UnsupportedConstructsPanel } from "@/components/state/UnsupportedConstructsPanel";
import { getWorkbenchReadiness } from "@/components/workbench/workbenchReadiness";
import { CodeEditor } from "@/components/editor/CodeEditor";
import type { StandaloneEditorMountArgs } from "@/components/editor/CodeEditor";
import {
  FixedFormatRuler,
  FixedFormatRulerToggle,
} from "@/components/editor/FixedFormatRuler";
import { getMonaco, useMonacoReady } from "@/lib/editor/lazyMonaco";
import {
  COBOL_LANGUAGE_ID,
  FIXED_FORMAT_RULER_COLUMNS,
  registerCobolLanguage,
} from "@/lib/editor/cobolMonarch";
import { registerCobolHoverProvider } from "@/lib/editor/cobolHoverProvider";
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
import type { EditorMarkerGroup } from "@/components/editor/codeEditorTypes";

// View-state preservation in Monaco is keyed by model URI. Re-using the same
// URI per source name keeps cursor / scroll / selection stable when the user
// switches between the COBOL editor and other panes; switching to a different
// file changes the URI so each file gets its own view state. The `inmemory://`
// scheme matches the convention used elsewhere in the studio (CodeEditorInner
// derives the same scheme for its fallback URIs).
function deriveModelUri(sourceName: string | null): string {
  const safeName = (sourceName || DEFAULT_SOURCE_NAME).replace(
    /[^a-zA-Z0-9_.\-]/g,
    "_",
  );
  return `inmemory://cobol-editor/${safeName}`;
}

const SAVE_NOTICE_VISIBLE_MS = 2500;

export function CobolEditorPane() {
  const {
    sourceText,
    setSourceText,
    expectedOutput,
    setExpectedOutput,
    oracleInput,
    setOracleInput,
    allowAiAssist,
    setAllowAiAssist,
    isDirty,
    sourceName,
    transformError,
    isTransforming,
    canSubmitTransform,
    submitTransform,
    bufferHash,
    statusFlags,
    conflict,
    resolveConflict,
    dismissConflict,
    saveDraftNow,
    saveNoticeAt,
  } = useSourceWorkspace();
  const [rulerEnabled, setRulerEnabled] = useState(false);
  const [showSaveNotice, setShowSaveNotice] = useState(false);

  const apiState = useC2cApi();
  const { productState, state: runState } = useTransformationRun();
  const readiness = getWorkbenchReadiness(apiState);
  const modelGatewayReady = runState.modelGatewayHealth?.status === "ok";
  const modelGatewayMessage =
    runState.modelGatewayHealth?.error ||
    "Model Gateway unavailable. AI-assisted transformation cannot start.";

  const editorRef = useRef<MonacoNs.editor.IStandaloneCodeEditor | null>(null);
  // Studio-IDE-5 (#244 review): bump on editor mount so the marker
  // memo recomputes with the live Monaco model — whole-line markers
  // require model.getLineLength().
  const [cobolEditorMountToken, setCobolEditorMountToken] = useState(0);
  const detectedProgramId = deriveDetectedProgramId(sourceText);
  const lineEnding = deriveDisplayedLineEnding(sourceText);
  const modelUri = useMemo(() => deriveModelUri(sourceName), [sourceName]);

  // Studio-IDE-5 (#244): collect typed diagnostics that target the
  // COBOL source — `sourceKind: "cobol"` and the IR step (which still
  // points at COBOL line numbers via `sourceLine`). The build/test and
  // generated-Java diagnostics are routed to the Java pane.
  const { registerOnMount: registerMarkerEditor } = useEditorMarkerRegistration(
    {
      id: "cobol-editor",
      filePath: sourceName ?? DEFAULT_SOURCE_NAME,
    },
  );
  // Studio-IDE-5 (#244 review): the marker memo depends on Monaco
  // having resolved. `useMonacoReady` returns null until the async
  // loader completes, then re-renders so the memo recomputes with the
  // real instance. Without this, a cold mount with diagnostics already
  // in state would cache an empty marker group permanently.
  const monaco = useMonacoReady();
  const cobolMarkerGroups: EditorMarkerGroup[] = useMemo(() => {
    if (!monaco) return [];
    const diagnostics = [
      ...(runState.generated?.diagnostics ?? []),
      ...(runState.buildTest?.diagnostics ?? []),
    ];
    const buckets = partitionByOwner(diagnostics);
    const currentFile = sourceName ?? DEFAULT_SOURCE_NAME;
    // Fix #244-review: only render diagnostics whose filePath
    // resolves to the open COBOL source. Path-segment matching
    // avoids cross-file misattribution (e.g. "Foo.cbl" matching
    // "BarFoo.cbl"). Diagnostics without filePath are run-level per
    // ADR 0006 Decision 4 and never become markers.
    const filterForCurrentFile = (d: (typeof diagnostics)[number]) => {
      if (!d.filePath) return false;
      const aParts = d.filePath.split(/[\\/]+/).filter(Boolean);
      const bParts = currentFile.split(/[\\/]+/).filter(Boolean);
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
    const cobolGroup = buckets["c2c-cobol"].filter(filterForCurrentFile);
    const irGroup = buckets["c2c-ir"].filter(filterForCurrentFile);
    // We do not have a stable handle to the live Monaco model here so
    // the marker mapper receives null; that degrades the whole-line
    // fallback to a single-character marker which the editor renders
    // safely. The CodeEditor re-applies markers after each model swap
    // so the next render with a model attached refines the geometry.
    const cobolMarkers = diagnosticsToMarkers(cobolGroup, {
      monaco,
      model: editorRef.current?.getModel() ?? null,
      limit: DEFAULT_MARKER_LIMIT,
    });
    const irMarkers = diagnosticsToMarkers(irGroup, {
      monaco,
      model: editorRef.current?.getModel() ?? null,
      limit: DEFAULT_MARKER_LIMIT,
    });
    return [
      { owner: "c2c-cobol", markers: cobolMarkers.markers },
      { owner: "c2c-ir", markers: irMarkers.markers },
    ];
    // cobolEditorMountToken is intentional — see review #244 round 3.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    monaco,
    runState.generated,
    runState.buildTest,
    sourceName,
    cobolEditorMountToken,
  ]);

  // Toast-equivalent visibility window for the "Saved locally" notice.
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

  // Register the COBOL language as soon as Monaco resolves. This runs in
  // parallel with CodeEditorInner's own getMonaco() resolution so the
  // language is typically registered before the initial model is created —
  // avoiding a brief plaintext flash on first render. The registration is
  // idempotent (see registerCobolLanguage) so the late onMount fallback
  // below is safe even when this effect wins the race.
  useEffect(() => {
    let cancelled = false;
    getMonaco()
      .then((monaco) => {
        if (cancelled) {
          return;
        }
        registerCobolLanguage(monaco);
        // Studio-IDE-9 (#254): register the deterministic hover
        // provider once the language is known. Registration is
        // idempotent so the onMount fallback below can re-call safely.
        registerCobolHoverProvider(monaco);
      })
      .catch(() => {
        // CodeEditor surfaces the load failure via its own error UI; nothing
        // useful to do here beyond not crashing.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Apply / clear Monaco's vertical ruler guides when the fixed-format toggle
  // flips. Monaco's `rulers` option draws thin vertical lines at the given
  // 1-based column positions; combined with the FixedFormatRuler legend
  // above the editor, this gives the user a precise per-column marker for
  // sequence (1-6), indicator (7), area A (8-11), area B (12-72), and the
  // identification area (73-80).
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) {
      return;
    }
    editor.updateOptions({
      rulers: rulerEnabled ? [...FIXED_FORMAT_RULER_COLUMNS] : [],
    });
  }, [rulerEnabled]);

  const handleEditorMount = useCallback(
    ({ editor, monaco }: StandaloneEditorMountArgs) => {
      editorRef.current = editor;
      registerMarkerEditor(editor);
      setCobolEditorMountToken((value) => value + 1);
      // Late-registration fallback in case the early effect lost the race
      // against CodeEditorInner's monaco resolution. Both registrations
      // are idempotent.
      registerCobolLanguage(monaco);
      registerCobolHoverProvider(monaco);
      // Apply the initial ruler state. The dedicated effect above handles
      // subsequent toggles; this mount-time call covers the case where the
      // toggle is already on before the editor mounted (e.g., a future
      // preference that persists across reloads).
      editor.updateOptions({
        rulers: rulerEnabled ? [...FIXED_FORMAT_RULER_COLUMNS] : [],
        // Word-based suggestions only — Monaco's default IntelliSense pulls
        // from open documents, which is the right level of help for COBOL
        // until a dedicated language server lands.
        wordBasedSuggestions: "currentDocument",
      });
      // Bind Cmd/Ctrl+S inside the editor surface to local-draft save.
      // Monaco intercepts the keystroke before the browser does, so this
      // works even when the editor has focus (where the global keyboard
      // shortcut hook ignores keydowns).
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
        void saveDraftNow();
      });
    },
    [rulerEnabled, saveDraftNow, registerMarkerEditor],
  );

  const conflictPanels: ConflictPanel[] = useMemo(() => {
    if (!conflict) {
      return [];
    }
    return [
      {
        id: "backendSample",
        title: "Backend sample",
        description: "The content the BFF supplied when this file was opened.",
        content: conflict.backendSample,
      },
      {
        id: "localDraft",
        title: "Local draft",
        description: "The content saved locally on this device.",
        content: conflict.localDraft,
      },
      {
        id: "lastRunInput",
        title: "Last run input",
        description:
          "The content that was sent to the last transformation run.",
        content: conflict.lastRunInput,
      },
    ];
  }, [conflict]);

  if (!sourceText && !isDirty) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-center">
        <div className="max-w-sm space-y-4">
          <p className="text-sm font-medium text-text">
            No source file selected
          </p>
          <p className="text-sm text-text-dim">
            Open a COBOL file from the Explorer or paste your own COBOL code
            here.
          </p>
          <button
            type="button"
            onClick={() => setSourceText("")}
            className="rounded bg-bg-2 px-4 py-2 text-sm text-text hover:bg-bg-3"
          >
            Start Typing
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden bg-bg-0">
      <div className="flex items-center justify-between border-b border-line px-4 py-2 shrink-0">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-medium text-text">
            {sourceName || DEFAULT_SOURCE_NAME} {isDirty && "*"}
          </h2>
          {detectedProgramId && (
            <span className="rounded bg-bg-2 px-2 py-1 text-[10px] text-text-dim">
              ID: {detectedProgramId}
            </span>
          )}
          <CobolStatusChips
            clean={statusFlags.clean}
            pendingReRun={statusFlags.pendingReRun}
          />
        </div>
        <div className="flex items-center gap-3">
          <FixedFormatRulerToggle
            enabled={rulerEnabled}
            onToggle={setRulerEnabled}
          />
          <div className="text-[10px] text-text-faint uppercase tracking-wider flex gap-3">
            <span>UTF-8</span>
            <span>{lineEnding}</span>
            <span title="Source Hash">#{bufferHash}</span>
          </div>
          <button
            type="button"
            onClick={() => {
              void submitTransform();
            }}
            disabled={!canSubmitTransform || !readiness.startEnabled}
            className="flex items-center gap-1 rounded bg-accent px-3 py-1.5 text-xs font-medium text-bg-0 hover:bg-accent-dim disabled:opacity-50"
          >
            <Play className="w-3.5 h-3.5" />
            {isTransforming ? "Transforming..." : "Start Transformation"}
          </button>
        </div>
      </div>

      {showSaveNotice ? (
        <div
          role="status"
          aria-live="polite"
          className="border-b border-success/20 bg-success-soft px-4 py-1.5 text-xs text-success"
        >
          Saved locally — this draft stays on your device. Use Start
          Transformation to commit the change to a run.
        </div>
      ) : null}

      {transformError && (
        <div className="bg-error/10 text-error px-4 py-2 text-sm border-b border-error/20">
          {transformError}
        </div>
      )}

      {productState.state === "unsupported" ? (
        <div className="border-b border-line bg-bg-1 px-4 py-3">
          <div className="text-sm font-medium text-warn">
            Unsupported COBOL constructs block this run.
          </div>
          <div className="mt-1 text-xs text-text-dim">
            Review the unsupported features before attempting another
            transformation.
          </div>
          <UnsupportedConstructsPanel
            constructs={productState.unsupportedFeatures || []}
          />
        </div>
      ) : null}

      <div className="grid gap-3 border-b border-line bg-bg-1 px-4 py-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_18rem]">
        <label className="flex min-w-0 flex-col gap-1">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-text-faint">
            Optional Expected Output
          </span>
          <textarea
            value={expectedOutput}
            onChange={(event) => setExpectedOutput(event.currentTarget.value)}
            spellCheck={false}
            aria-label="Optional expected output for oracle comparison"
            placeholder="Leave empty to derive the oracle through COBOL runtime when available."
            className="h-20 resize-none overflow-auto rounded border border-line-2 bg-bg-0 p-2 font-mono text-xs text-text outline-none placeholder:text-text-faint focus:border-accent"
          />
        </label>
        <label className="flex min-w-0 flex-col gap-1">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-text-faint">
            Optional Oracle Input
          </span>
          <textarea
            value={oracleInput}
            onChange={(event) => setOracleInput(event.currentTarget.value)}
            spellCheck={false}
            aria-label="Optional oracle input"
            placeholder="Stdin passed to the COBOL oracle; leave empty for no input."
            className="h-20 resize-none overflow-auto rounded border border-line-2 bg-bg-0 p-2 font-mono text-xs text-text outline-none placeholder:text-text-faint focus:border-accent"
          />
        </label>
        <label className="flex min-w-0 flex-col justify-between gap-3 rounded border border-line-2 bg-bg-0 p-3 text-xs text-text">
          <span>
            <span className="block text-[10px] font-semibold uppercase tracking-wider text-text-faint">
              AI Assist
            </span>
            <span className="mt-1 block text-text-dim">
              Default on. The orchestrator still runs the deterministic baseline
              first and may activate the Transformation Agent only after the
              assist-decision gate.
            </span>
          </span>
          <span className="flex items-center justify-between gap-3">
            <span className="font-medium">Allow controlled assist</span>
            <input
              type="checkbox"
              checked={allowAiAssist}
              onChange={(event) =>
                setAllowAiAssist(event.currentTarget.checked)
              }
              aria-label="Allow AI assist after deterministic baseline"
              className="h-4 w-4 rounded border-line-2 bg-bg-1 text-accent focus:ring-accent"
            />
          </span>
          {allowAiAssist &&
          runState.modelGatewayHealth &&
          !modelGatewayReady ? (
            <span className="rounded border border-error/30 bg-error/10 p-2 text-error">
              {modelGatewayMessage} Disable AI Assist to run deterministic-only.
            </span>
          ) : null}
        </label>
      </div>

      {rulerEnabled ? (
        <div className="border-b border-line bg-bg-1 px-4 py-2">
          <FixedFormatRuler />
        </div>
      ) : null}

      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/*
          Controlled-input strategy (Issue #246): we pass `value={sourceText}`
          and `onChange={setSourceText}` and rely on CodeEditorInner's hardened
          wrapper to avoid the cursor-jump bug common in controlled Monaco
          integrations. Specifically, CodeEditorInner suppresses onChange for
          (a) whole-model `isFlush` replacements that fire when @monaco-editor/
          react flushes a new value prop, and (b) `executeEdits`-driven prop
          refreshes via value-equality against the latest sanitized prop
          (see codeEditorWiring.test.ts). That combination keeps the React
          state and Monaco's model in sync without the editor stealing or
          resetting the user's caret position on every keystroke. The submit
          path reads from `sourceText` directly (see submitTransform in
          stores/sourceWorkspace.tsx), so the controlled prop already matches
          the editor's current content at submit time — no race condition
          and no need for an editor.getValue() round-trip.
        */}
        <CodeEditor
          mode="editable"
          language={COBOL_LANGUAGE_ID}
          value={sourceText}
          onChange={setSourceText}
          modelUri={modelUri}
          ariaLabel={`${sourceName || DEFAULT_SOURCE_NAME} COBOL source editor`}
          onMount={handleEditorMount}
          markerGroups={cobolMarkerGroups}
          className="flex-1 min-h-0"
        />
      </div>

      {conflict ? (
        <ConflictResolverDialog
          kind="cobol"
          panels={conflictPanels}
          onChoose={resolveConflict}
          onDismiss={dismissConflict}
        />
      ) : null}
    </div>
  );
}

// Status chips render the (buffer, lastRunInput, displayedArtifact) hash
// relationships described in #247: `clean` (everything matches), and
// `pending re-run` (buffer differs from last-run input). For COBOL the
// `stale java` chip is N/A — that chip lives on the Java pane.
function CobolStatusChips({
  clean,
  pendingReRun,
}: {
  clean: boolean;
  pendingReRun: boolean;
}) {
  if (!clean && !pendingReRun) {
    return null;
  }
  return (
    <span className="flex items-center gap-1" data-testid="cobol-status-chips">
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
    </span>
  );
}
