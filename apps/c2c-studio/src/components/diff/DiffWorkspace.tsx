"use client";

/**
 * Studio-IDE-7 (#252): Synchronized Diff Workflow (Java + COBOL).
 *
 * Side-by-side Java diff between two run states of the same file paired
 * with a synchronized COBOL diff of the inputs. Lineage anchors couple
 * the two diff editors so reviewers see cause→effect at a glance.
 *
 * Inputs flow from ``transformationRun`` (history accumulator) and
 * ``lineageNavigation`` (Java↔COBOL anchor resolution). The component
 * never mutates either store — purely a viewer.
 */

import type * as MonacoNs from "monaco-editor";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { X } from "lucide-react";

import { CodeEditor } from "@/components/editor/CodeEditor";
import type { DiffEditorMountArgs } from "@/components/editor/CodeEditor";
import { detectLanguageFromPath } from "@/lib/editor/languageDetection";
import type {
  CobolSnapshot,
  JavaFileHistoryEntry,
} from "@/lib/editor/diffHistory";
import { emit as emitTelemetry } from "@/lib/editor/editorTelemetry";
import {
  fetchTraceability,
  TraceabilityNotFoundError,
  type ParsedTrace,
} from "@/lib/editor/traceParser";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DiffWorkspaceProps {
  /** Generated Java file path the diff is anchored to. */
  filePath: string;
  /** Program identifier (``sourceKey``) — same key the BFF stamps on runs. */
  sourceKey: string;
  /** The active run that produced the "current" Java snapshot. */
  runId: string;
  javaHistory: JavaFileHistoryEntry | undefined;
  /**
   * COBOL snapshots keyed by runId for this ``sourceKey``. DiffWorkspace
   * resolves the previous/current COBOL pair by looking up the runIds
   * present in ``javaHistory`` so the two diff panes always render the
   * SAME run pair (Copilot review #282 — failed runs between successes
   * must not desync the panes).
   */
  cobolSnapshotsByRun: Record<string, CobolSnapshot> | undefined;
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

// Coupled-scroll throttle. ~30 Hz per the issue's technical-approach note;
// this gives a perceptibly smooth follow without flooding the editor's
// reveal API or the lineage resolver.
const SCROLL_THROTTLE_MS = 33;

type FocusSide = "java" | "cobol";

interface JumpableDiff {
  editor: MonacoNs.editor.IStandaloneDiffEditor;
}

// F7 / Shift+F7 hunk navigation. Walks Monaco's ``getLineChanges`` list
// relative to the cursor in the modified editor. When the cursor sits
// before the first hunk, ``next`` lands on the first one; before is
// symmetric. Falls back to no-op when the diff has no changes.
function jumpToHunk(diff: JumpableDiff, direction: "next" | "prev"): void {
  const changes = diff.editor.getLineChanges();
  if (!changes || changes.length === 0) return;
  const modified = diff.editor.getModifiedEditor();
  const pos = modified.getPosition();
  const currentLine = pos?.lineNumber ?? 0;
  let target: MonacoNs.editor.ILineChange | undefined;
  if (direction === "next") {
    target =
      changes.find((c) => c.modifiedStartLineNumber > currentLine) ??
      changes[0];
  } else {
    target =
      [...changes]
        .reverse()
        .find(
          (c) =>
            (c.modifiedEndLineNumber || c.modifiedStartLineNumber) <
            currentLine,
        ) ?? changes[changes.length - 1];
  }
  if (!target) return;
  const line = Math.max(1, target.modifiedStartLineNumber);
  modified.revealLineInCenter(line);
  modified.setPosition({ lineNumber: line, column: 1 });
  modified.focus();
}

// Synchronous lineage resolve that re-uses a pre-fetched ParsedTrace. The
// upstream ``resolveJavaToCobol`` is async (it owns the cache); for the
// coupled-scroll loop we fetch once on mount and then call this helper
// without re-entering the cache layer on every tick.
function resolveJavaToCobolSync(
  parsed: ParsedTrace,
  javaFile: string,
  javaLine: number,
  javaSource: string,
): { cobolLine: number } | null {
  const regions = parsed.javaRegionClassification.get(javaFile);
  if (!regions || regions.length === 0) return null;
  const enclosing = regions.find(
    (r) => javaLine >= r.lineRange.startLine && javaLine <= r.lineRange.endLine,
  );
  if (!enclosing) return null;
  if (
    enclosing.originClass === "manual_modified" ||
    enclosing.originClass === "manual_edit"
  ) {
    return null;
  }
  // Mine inline anchors lazily; the source string is small enough that
  // this is cheaper than maintaining a separate per-file anchor cache.
  const lines = javaSource.split(/\r?\n/);
  let chosen: { line: number; irNodeId: string } | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const m =
      /^\s*\/\/\s+\w+(?:\s+\S+)?\s+\[([a-z][a-z0-9-]*)\s+line\s+(\d+)\]/.exec(
        lines[i],
      );
    if (!m) continue;
    const anchorLine = i + 1;
    if (anchorLine < enclosing.lineRange.startLine) continue;
    if (anchorLine > enclosing.lineRange.endLine) continue;
    if (anchorLine > javaLine) continue;
    if (!chosen || anchorLine > chosen.line) {
      chosen = { line: anchorLine, irNodeId: m[1] };
    }
  }
  if (!chosen) return null;
  const ir = parsed.irSymbolMap.get(chosen.irNodeId);
  if (!ir) return null;
  return { cobolLine: ir.cobolLine };
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface EmptyShellProps {
  filePath: string;
  message: string;
  hint?: string;
  onClose: () => void;
}

function EmptyShell({ filePath, message, hint, onClose }: EmptyShellProps) {
  const { dialogRef, handleDialogKeyDown } = useDialogKeyboard(onClose);
  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="diffworkspace-title"
      tabIndex={-1}
      onKeyDown={handleDialogKeyDown}
      data-testid="diff-workspace-empty"
      className="fixed inset-0 z-40 flex flex-col bg-bg-0/95 backdrop-blur-sm"
    >
      <div className="flex shrink-0 items-center justify-between border-b border-line bg-bg-1 px-4 py-2">
        <h2
          id="diffworkspace-title"
          className="truncate text-sm font-medium text-text"
        >
          Compare Runs — {filePath.split("/").pop()}
        </h2>
        <button
          type="button"
          aria-label="Close compare runs"
          onClick={onClose}
          className="rounded p-1 text-text-dim hover:bg-bg-2 hover:text-text"
        >
          <X size={16} />
        </button>
      </div>
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-text-dim">
        <p className="text-sm">{message}</p>
        {hint ? <p className="text-xs">{hint}</p> : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function DiffWorkspace({
  filePath,
  sourceKey,
  runId,
  javaHistory,
  cobolSnapshotsByRun,
  onClose,
}: DiffWorkspaceProps) {
  // ----- Empty state: no previous run for this file ---------------------
  if (!javaHistory || javaHistory.previous === null) {
    // Studio-IDE-11 (#251): emit the empty-shell case once with the
    // load-bearing booleans. The body owns the populated case so
    // ``lineageAvailable`` reports the real resolved state instead of a
    // constant ``false``.
    return <DiffWorkspaceEmpty filePath={filePath} onClose={onClose} />;
  }

  return (
    <DiffWorkspaceBody
      filePath={filePath}
      sourceKey={sourceKey}
      runId={runId}
      javaHistory={javaHistory}
      cobolSnapshotsByRun={cobolSnapshotsByRun}
      onClose={onClose}
    />
  );
}

interface DiffWorkspaceEmptyProps {
  filePath: string;
  onClose: () => void;
}

function DiffWorkspaceEmpty({ filePath, onClose }: DiffWorkspaceEmptyProps) {
  useEffect(() => {
    emitTelemetry({
      eventType: "diff.open",
      payload: { hasPrevious: false, lineageAvailable: false },
    });
  }, [filePath]);
  return (
    <EmptyShell
      filePath={filePath}
      message="No previous run for this file to compare."
      hint="Start a new transformation to build up comparison history."
      onClose={onClose}
    />
  );
}

// Splitting the populated state into a separate component lets the
// outer ``DiffWorkspace`` early-return for the empty case without
// triggering the hooks below to run with placeholder data — which would
// otherwise violate the rules of hooks if the user toggled between
// states without remount.
interface DiffWorkspaceBodyProps {
  filePath: string;
  sourceKey: string;
  runId: string;
  javaHistory: JavaFileHistoryEntry;
  cobolSnapshotsByRun: Record<string, CobolSnapshot> | undefined;
  onClose: () => void;
}

function DiffWorkspaceBody({
  filePath,
  sourceKey,
  runId,
  javaHistory,
  cobolSnapshotsByRun,
  onClose,
}: DiffWorkspaceBodyProps) {
  const language = useMemo(() => detectLanguageFromPath(filePath), [filePath]);
  const { dialogRef, handleDialogKeyDown } = useDialogKeyboard(onClose);

  const previousJava = javaHistory.previous;
  const currentJava = javaHistory.current;
  // Body only renders when previous is populated.
  // (The outer DiffWorkspace early-returns otherwise.)
  if (!previousJava) {
    throw new Error(
      "DiffWorkspaceBody invariant: previousJava must be populated",
    );
  }
  // Studio-IDE-7 review-finding (Copilot, PR #282): pair the COBOL
  // snapshots by the Java runIds rather than maintaining a separate
  // previous/current sliding window. If a failed run sits between the
  // two displayed runs the lookup naturally skips it instead of
  // shifting COBOL out of phase with Java.
  const previousCobol = cobolSnapshotsByRun?.[previousJava.runId] ?? null;
  const currentCobol = cobolSnapshotsByRun?.[currentJava.runId] ?? null;
  const cobolPresent = previousCobol !== null && currentCobol !== null;

  // ----- Traceability fetch (lineage availability) ----------------------
  const [trace, setTrace] = useState<ParsedTrace | null>(null);
  const [lineageReady, setLineageReady] = useState(false);
  const [lineageAvailable, setLineageAvailable] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setLineageReady(false);
    setLineageAvailable(false);
    void fetchTraceability(runId).then(
      (parsed) => {
        if (cancelled) return;
        setTrace(parsed);
        const regions = parsed.javaRegionClassification.get(filePath) ?? [];
        setLineageAvailable(regions.length > 0);
        setLineageReady(true);
      },
      (err: unknown) => {
        if (cancelled) return;
        setTrace(null);
        if (err instanceof TraceabilityNotFoundError) {
          setLineageAvailable(false);
        }
        setLineageReady(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [runId, filePath]);

  // ----- Linked-scroll toggle ------------------------------------------
  // Defaults to ``true``; the effect below force-clears it when lineage
  // becomes unavailable so the user sees a clean uncoupled state.
  const [linkedScroll, setLinkedScroll] = useState(true);
  useEffect(() => {
    if (lineageReady && (!lineageAvailable || !cobolPresent)) {
      setLinkedScroll(false);
    }
  }, [lineageReady, lineageAvailable, cobolPresent]);

  // Studio-IDE-11 (#251): emit diff.open once per (runId, filePath)
  // when the traceability fetch resolves so ``lineageAvailable`` is
  // the real resolved value (true/false), not a placeholder. The
  // body component is only mounted when ``hasPrevious`` is true (the
  // outer ``DiffWorkspace`` early-returns the empty case), so the
  // payload field is a constant ``true`` here.
  useEffect(() => {
    if (!lineageReady) return;
    emitTelemetry({
      eventType: "diff.open",
      payload: { hasPrevious: true, lineageAvailable },
    });
  }, [lineageReady, lineageAvailable, runId, filePath]);

  const couplingDisabled = !lineageAvailable || !cobolPresent;

  // ----- Diff editor refs ----------------------------------------------
  const javaDiffRef = useRef<MonacoNs.editor.IStandaloneDiffEditor | null>(
    null,
  );
  const cobolDiffRef = useRef<MonacoNs.editor.IStandaloneDiffEditor | null>(
    null,
  );

  const [focusSide, setFocusSide] = useState<FocusSide>("java");
  const focusSideRef = useRef<FocusSide>("java");
  focusSideRef.current = focusSide;
  const linkedScrollRef = useRef(linkedScroll);
  linkedScrollRef.current = linkedScroll;
  const traceRef = useRef<ParsedTrace | null>(trace);
  traceRef.current = trace;
  // Studio-IDE-7 review-finding (Codex P1, PR #282): the scroll listener
  // is registered ONCE in handleJavaMount, before lineage has loaded
  // (``couplingDisabled`` is true at that moment). Reading
  // ``couplingDisabled`` from the closure would freeze the handler in
  // the "coupling off" state forever — even after traceability resolves.
  // Read through refs so the single registered listener always sees the
  // latest coupling / file-path state.
  const couplingDisabledRef = useRef(couplingDisabled);
  couplingDisabledRef.current = couplingDisabled;
  const filePathRef = useRef(filePath);
  filePathRef.current = filePath;

  // ----- Scroll coupling -----------------------------------------------
  // The Java diff is the source-of-truth for coupling: when the user
  // scrolls Java, we look up the line in COBOL via lineage and reveal
  // it. Reverse coupling (COBOL → Java) would require an inverse
  // anchor walk; the issue body specifies "when the user scrolls the
  // Java diff to a line that has lineage to a COBOL line, the COBOL
  // diff auto-scrolls", so we implement that one direction only.
  const lastScrollAtRef = useRef(0);
  const pendingScrollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleJavaScroll = useCallback(() => {
    if (!linkedScrollRef.current) return;
    if (couplingDisabledRef.current) return;
    const java = javaDiffRef.current;
    const cobol = cobolDiffRef.current;
    if (!java || !cobol) return;
    const parsed = traceRef.current;
    if (!parsed) return;
    const javaModified = java.getModifiedEditor();
    const visibleRanges = javaModified.getVisibleRanges();
    if (visibleRanges.length === 0) return;
    const firstVisible = visibleRanges[0];
    if (!firstVisible) return;
    const focusedLine = firstVisible.startLineNumber;
    const javaSource = javaModified.getModel()?.getValue() ?? "";
    const resolved = resolveJavaToCobolSync(
      parsed,
      filePathRef.current,
      focusedLine,
      javaSource,
    );
    if (!resolved) return;
    const cobolModified = cobol.getModifiedEditor();
    cobolModified.revealLineInCenter(resolved.cobolLine);
  }, []);

  // Throttle the scroll handler. We coalesce a trailing call so the
  // final scroll position is always honored.
  const scheduleScrollSync = useCallback(() => {
    const now = Date.now();
    const elapsed = now - lastScrollAtRef.current;
    if (elapsed >= SCROLL_THROTTLE_MS) {
      lastScrollAtRef.current = now;
      handleJavaScroll();
      return;
    }
    if (pendingScrollRef.current !== null) return;
    const delay = SCROLL_THROTTLE_MS - elapsed;
    pendingScrollRef.current = setTimeout(() => {
      pendingScrollRef.current = null;
      lastScrollAtRef.current = Date.now();
      handleJavaScroll();
    }, delay);
  }, [handleJavaScroll]);

  useEffect(() => {
    return () => {
      if (pendingScrollRef.current !== null) {
        clearTimeout(pendingScrollRef.current);
        pendingScrollRef.current = null;
      }
    };
  }, []);

  // Studio-IDE-12 (#250): track Monaco command disposables from both
  // diff editors so they are released on unmount. Without this each
  // remount of the diff workspace stacks four more F7/Shift+F7 handlers
  // per editor side.
  const diffActionDisposablesRef = useRef<MonacoNs.IDisposable[]>([]);
  const trackDiffDisposable = useCallback(
    (disposable: MonacoNs.IDisposable | string | null) => {
      if (
        disposable &&
        typeof disposable !== "string" &&
        typeof disposable.dispose === "function"
      ) {
        diffActionDisposablesRef.current.push(disposable);
      }
    },
    [],
  );

  const handleJavaMount = useCallback(
    ({ editor, monaco }: DiffEditorMountArgs) => {
      javaDiffRef.current = editor;
      // Studio-IDE-7 review-finding (Copilot, PR #282): F7 / Shift+F7
      // must work regardless of which side of the diff has focus. We
      // register the same commands on BOTH underlying editors so a
      // user-focused original (left) pane still cycles hunks.
      const modified = editor.getModifiedEditor();
      const original = editor.getOriginalEditor();
      const onFocus = () => setFocusSide("java");
      trackDiffDisposable(modified.onDidFocusEditorWidget(onFocus));
      trackDiffDisposable(original.onDidFocusEditorWidget(onFocus));
      const goNext = () => jumpToHunk({ editor }, "next");
      const goPrev = () => jumpToHunk({ editor }, "prev");
      trackDiffDisposable(modified.addCommand(monaco.KeyCode.F7, goNext));
      trackDiffDisposable(
        modified.addCommand(monaco.KeyMod.Shift | monaco.KeyCode.F7, goPrev),
      );
      trackDiffDisposable(original.addCommand(monaco.KeyCode.F7, goNext));
      trackDiffDisposable(
        original.addCommand(monaco.KeyMod.Shift | monaco.KeyCode.F7, goPrev),
      );
      trackDiffDisposable(modified.onDidScrollChange(scheduleScrollSync));
    },
    [scheduleScrollSync, trackDiffDisposable],
  );

  const handleCobolMount = useCallback(
    ({ editor, monaco }: DiffEditorMountArgs) => {
      cobolDiffRef.current = editor;
      const modified = editor.getModifiedEditor();
      const original = editor.getOriginalEditor();
      const onFocus = () => setFocusSide("cobol");
      trackDiffDisposable(modified.onDidFocusEditorWidget(onFocus));
      trackDiffDisposable(original.onDidFocusEditorWidget(onFocus));
      // Studio-IDE-7 review-finding (Copilot, PR #282): bind on both
      // sides — see corresponding note in ``handleJavaMount``.
      const goNext = () => jumpToHunk({ editor }, "next");
      const goPrev = () => jumpToHunk({ editor }, "prev");
      trackDiffDisposable(modified.addCommand(monaco.KeyCode.F7, goNext));
      trackDiffDisposable(
        modified.addCommand(monaco.KeyMod.Shift | monaco.KeyCode.F7, goPrev),
      );
      trackDiffDisposable(original.addCommand(monaco.KeyCode.F7, goNext));
      trackDiffDisposable(
        original.addCommand(monaco.KeyMod.Shift | monaco.KeyCode.F7, goPrev),
      );
    },
    [trackDiffDisposable],
  );

  // Studio-IDE-12 (#250): unmount cleanup — dispose every command,
  // action, and listener registration captured at mount time. Both
  // diff editors share the same disposable list because the workspace
  // owns the lifetime of both panes.
  useEffect(() => {
    return () => {
      for (const disposable of diffActionDisposablesRef.current) {
        try {
          disposable.dispose();
        } catch {
          // Idempotent cleanup; the underlying editor may already be
          // torn down by the time React invokes the effect.
        }
      }
      diffActionDisposablesRef.current = [];
    };
  }, []);

  // ----- Render ---------------------------------------------------------
  // Stable model URIs scoped to (sourceKey, runId, filePath) so view state
  // (cursor, scroll, fold ranges) is preserved when the user toggles the
  // Linked-scroll button or moves focus between the two editors.
  const javaModelUri = useMemo(
    () =>
      `inmemory://c2c-studio/diff/java/${sourceKey}/${runId}/${filePath}~modified`,
    [sourceKey, runId, filePath],
  );
  const javaOriginalUri = useMemo(
    () =>
      `inmemory://c2c-studio/diff/java/${sourceKey}/${previousJava.runId}/${filePath}~original`,
    [sourceKey, previousJava.runId, filePath],
  );
  const cobolModelUri = useMemo(
    () =>
      `inmemory://c2c-studio/diff/cobol/${sourceKey}/${currentJava.runId}~modified`,
    [sourceKey, currentJava.runId],
  );
  const cobolOriginalUri = useMemo(
    () =>
      `inmemory://c2c-studio/diff/cobol/${sourceKey}/${previousJava.runId}~original`,
    [sourceKey, previousJava.runId],
  );

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="diffworkspace-title"
      tabIndex={-1}
      onKeyDown={handleDialogKeyDown}
      data-testid="diff-workspace"
      data-focus-side={focusSide}
      data-linked-scroll={linkedScroll}
      className="fixed inset-0 z-40 flex flex-col bg-bg-0/95 backdrop-blur-sm"
    >
      <div className="flex shrink-0 items-center justify-between border-b border-line bg-bg-1 px-4 py-2">
        <div className="flex items-center gap-2 overflow-hidden">
          <h2
            id="diffworkspace-title"
            className="truncate text-sm font-medium text-text"
          >
            Compare Runs — {filePath.split("/").pop()}
          </h2>
          <span className="truncate text-xs text-text-dim">{filePath}</span>
        </div>
        <div className="flex items-center gap-2">
          <label
            data-testid="diff-workspace-linked-scroll-toggle"
            className="flex items-center gap-1.5 text-xs text-text-dim select-none cursor-pointer"
            title={
              couplingDisabled
                ? "Lineage unavailable — coupling cannot be enabled."
                : "Toggle scroll coupling between the Java and COBOL diffs."
            }
          >
            <input
              type="checkbox"
              checked={linkedScroll}
              disabled={couplingDisabled}
              onChange={(e) => setLinkedScroll(e.target.checked)}
              aria-label="Linked scroll"
              className="h-3 w-3 accent-accent"
            />
            <span>Linked scroll</span>
          </label>
          <span
            className="hidden text-[10px] text-text-dim md:inline"
            title="F7 jumps to the next hunk; Shift+F7 jumps to the previous hunk."
          >
            F7 next · Shift+F7 prev
          </span>
          <button
            type="button"
            aria-label="Close compare runs"
            onClick={onClose}
            className="rounded p-1 text-text-dim hover:bg-bg-2 hover:text-text"
          >
            <X size={16} />
          </button>
        </div>
      </div>

      {couplingDisabled && lineageReady ? (
        <div
          role="status"
          aria-live="polite"
          data-testid="diff-workspace-uncoupled-notice"
          className="shrink-0 border-b border-warn/20 bg-warn-soft px-4 py-1.5 text-xs text-warn"
        >
          {cobolPresent
            ? "Lineage unavailable — scrolls are independent."
            : "No previous COBOL input recorded — COBOL diff is unavailable."}
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1 flex-col border-b border-line">
          <div className="shrink-0 bg-bg-1 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-text-dim">
            Java · previous (run {previousJava.runId.slice(0, 8)}) → current
            (run {currentJava.runId.slice(0, 8)})
          </div>
          <div className="min-h-0 flex-1" data-testid="diff-workspace-java">
            <CodeEditor
              mode="diff"
              language={language}
              original={previousJava.content}
              value={currentJava.content}
              modelUri={javaModelUri}
              originalModelUri={javaOriginalUri}
              ariaLabel={`Java diff for ${filePath}`}
              onMount={handleJavaMount}
              className="h-full"
            />
          </div>
        </div>
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="shrink-0 bg-bg-1 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-text-dim">
            COBOL ·{" "}
            {cobolPresent
              ? `previous (run ${previousCobol.runId.slice(0, 8)}) → current (run ${currentCobol.runId.slice(0, 8)})`
              : "no previous input available"}
          </div>
          <div className="min-h-0 flex-1" data-testid="diff-workspace-cobol">
            {cobolPresent ? (
              <CodeEditor
                mode="diff"
                language="cobol"
                original={previousCobol.content}
                value={currentCobol.content}
                modelUri={cobolModelUri}
                originalModelUri={cobolOriginalUri}
                ariaLabel="COBOL input diff"
                onMount={handleCobolMount}
                className="h-full"
              />
            ) : (
              <div
                data-testid="diff-workspace-cobol-empty"
                className="flex h-full items-center justify-center bg-bg-0 px-6 text-center text-xs text-text-dim"
              >
                <p>No previous COBOL input recorded for this program.</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function useDialogKeyboard(onClose: () => void): {
  dialogRef: RefObject<HTMLDivElement>;
  handleDialogKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
} {
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    dialogRef.current?.focus();
    return () => {
      if (previous instanceof HTMLElement) {
        previous.focus();
      }
    };
  }, []);
  const handleDialogKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
    },
    [onClose],
  );
  return { dialogRef, handleDialogKeyDown };
}
