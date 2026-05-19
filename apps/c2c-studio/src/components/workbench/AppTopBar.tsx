"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Play,
  Settings,
  Search,
  CheckCircle2,
  AlertCircle,
  MoreHorizontal,
  Trash2,
  Hammer,
  Wand2,
  RotateCw,
  ShieldCheck,
} from "lucide-react";
import { type StudioApiState } from "../../hooks/useC2cApi";
import { getWorkbenchReadiness } from "./workbenchReadiness";
import { useSourceWorkspace } from "../../stores/sourceWorkspace";
import { useTransformationRun } from "../../stores/transformationRun";
import { useKeyboardShortcuts } from "../../hooks/useKeyboardShortcuts";
import { AppLogo } from "../icons/AppLogo";
import {
  editorPersistence,
  getCurrentDraftScope,
  type DraftScope,
} from "../../lib/editor/editorPersistence";
import { useJavaEditorActions } from "../../stores/javaEditorActions";
import { emit as emitTelemetry } from "../../lib/editor/editorTelemetry";

interface AppTopBarProps {
  apiState: StudioApiState;
}

export function AppTopBar({ apiState }: AppTopBarProps) {
  const { loading } = apiState;
  const readiness = getWorkbenchReadiness(apiState);
  const { canSubmitTransform, submitTransform, submitGenerate } =
    useSourceWorkspace();
  const { state: runState, javaBuffers, startVerify } = useTransformationRun();
  const canStart = readiness.startEnabled && !loading && canSubmitTransform;
  // Studio-IDE-14 (#256): Compile Check is rendered as a sibling of the
  // Start button. The Java editor pane registers an imperative handler
  // through the JavaEditorActionsProvider; when no pane is mounted the
  // button stays disabled.
  const { canCompileCheck, compileCheckPending, triggerCompileCheck } =
    useJavaEditorActions();

  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [clearDraftsScope, setClearDraftsScope] = useState<DraftScope | null>(
    null,
  );
  const [clearDraftsCount, setClearDraftsCount] = useState<number | null>(null);
  const [clearDraftsLoading, setClearDraftsLoading] = useState(false);
  const [clearDraftsPending, setClearDraftsPending] = useState(false);
  const [clearDraftsError, setClearDraftsError] = useState<string | null>(null);
  // Studio-IDE-13 (#255): Regenerate confirmation modal. The Regenerate
  // toolbar action always confirms first per the issue spec.
  const [regenerateConfirmOpen, setRegenerateConfirmOpen] = useState(false);
  const [verifyPending, setVerifyPending] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Whether *any* generated Java buffer the Studio has hydrated currently
  // diverges from its captured Generator Baseline. Used to short-circuit
  // Generate / Regenerate into the confirmation modal so manual edits
  // never silently disappear (AC3 of #255).
  const hasManualEditsAnywhere = Object.values(javaBuffers).some(
    (entry) =>
      entry.generatorBaselineHash.length > 0 &&
      entry.bufferHash !== entry.generatorBaselineHash,
  );

  const handleGenerate = useCallback(() => {
    if (hasManualEditsAnywhere) {
      // Per AC3, even "Generate Java" must not silently overwrite manual
      // edits. We open the confirmation modal so the user explicitly
      // proceeds; the actual merge UI fires from the editor pane when
      // the new run lands.
      setRegenerateConfirmOpen(true);
      return;
    }
    void submitGenerate();
  }, [hasManualEditsAnywhere, submitGenerate]);

  const handleRegenerate = useCallback(() => {
    // Regenerate always confirms first (AC: "always confirms via modal
    // first"), regardless of whether manual edits exist.
    setRegenerateConfirmOpen(true);
  }, []);

  const handleConfirmRegenerate = useCallback(() => {
    setRegenerateConfirmOpen(false);
    void submitGenerate();
  }, [submitGenerate]);

  const handleVerifyCurrentBuffers = useCallback(async () => {
    const runId = runState.runId;
    if (!runId) return;
    const entries = Object.entries(javaBuffers);
    if (entries.length === 0) return;
    setVerifyPending(true);
    try {
      const javaFiles = entries.map(([path, entry]) => ({
        path,
        content: entry.content,
      }));
      // Pick the first non-null overlay if any buffer has one (single-
      // file Studio scope today); the BFF only needs aggregate counts
      // for stamping the run-summary fields.
      const firstOverlay = entries
        .map(([, entry]) => entry.manualEditOverlay)
        .find((overlay) => overlay !== null);
      await startVerify({
        runId,
        javaFiles,
        ...(firstOverlay ? { manualEditOverlay: firstOverlay } : {}),
      });
    } finally {
      setVerifyPending(false);
    }
  }, [runState.runId, javaBuffers, startVerify]);

  const canVerifyCurrentBuffers =
    runState.runId !== null &&
    Object.keys(javaBuffers).length > 0 &&
    !verifyPending;
  const canGenerate = canStart;
  const canRegenerate = canStart;

  useKeyboardShortcuts({
    onStartTransform: () => {
      void submitTransform();
    },
    canStartTransform: canStart,
  });

  // Close the dropdown when the user clicks outside it. Confirmation modal
  // has its own focus trap below.
  useEffect(() => {
    if (!menuOpen) {
      return;
    }
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [menuOpen]);

  const showFeedback = useCallback((message: string) => {
    setFeedback(message);
    setTimeout(() => setFeedback(null), 4000);
  }, []);

  const openClearDraftsDialog = useCallback(() => {
    setMenuOpen(false);
    setConfirmOpen(true);
    setClearDraftsScope(null);
    setClearDraftsCount(null);
    setClearDraftsError(null);
    setClearDraftsLoading(true);
    void (async () => {
      try {
        const scope = await getCurrentDraftScope();
        const drafts = await editorPersistence.listDrafts(scope);
        setClearDraftsScope(scope);
        setClearDraftsCount(drafts.length);
      } catch {
        setClearDraftsError("Sign in again to clear local drafts.");
      } finally {
        setClearDraftsLoading(false);
      }
    })();
  }, []);

  const onClearDrafts = useCallback(async () => {
    if (!clearDraftsScope || clearDraftsLoading || clearDraftsPending) {
      return;
    }
    setClearDraftsPending(true);
    setClearDraftsError(null);
    try {
      const result = await editorPersistence.clearAll(clearDraftsScope);
      emitTelemetry({
        eventType: "drafts.cleared",
        payload: {
          purgedCountBucket: bucketDraftCount(result.purgedCount),
        },
      });
      setConfirmOpen(false);
      showFeedback(
        result.purgedCount === 0
          ? "No local drafts to clear."
          : `Cleared ${result.purgedCount} local draft${
              result.purgedCount === 1 ? "" : "s"
            }.`,
      );
    } catch {
      setClearDraftsError("Unable to clear local drafts. Sign in again.");
    } finally {
      setClearDraftsPending(false);
    }
  }, [
    clearDraftsLoading,
    clearDraftsPending,
    clearDraftsScope,
    showFeedback,
  ]);

  return (
    <header
      className="flex min-h-12 w-full flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-line bg-bg-1 px-4 py-2 shrink-0"
      aria-label="Workbench Top Bar"
    >
      <div className="flex min-w-0 items-center gap-4">
        <h1 className="sr-only">c2c Studio Workbench</h1>
        <div className="flex min-w-0 items-center gap-2" aria-label="c2c brand">
          <AppLogo compact />
          <span className="text-sm font-semibold text-text">c2c by Keiko</span>
        </div>
        <div className="h-4 w-px bg-line-2"></div>
        <div className="flex min-w-0 items-center gap-2 text-sm text-text-dim">
          <span className="font-medium text-text">Workspace</span>
          <span className="text-text-faint">/</span>
          <span className="truncate">main</span>
        </div>
      </div>

      <div className="flex min-w-0 items-center gap-2">
        <div className="flex min-w-0 items-center gap-1 rounded border border-line-2 bg-bg-2 px-2 py-1">
          <span className="text-xs text-text-dim">Run Config:</span>
          <span className="truncate text-xs font-medium text-text">
            Default Transform
          </span>
        </div>
        <button
          type="button"
          data-testid="topbar-generate-and-verify-button"
          disabled={!canStart}
          className="flex items-center justify-center rounded bg-teal hover:bg-teal-soft active:bg-teal disabled:opacity-50 disabled:cursor-not-allowed p-1.5 focus-visible:ring-1 focus-visible:ring-accent outline-none"
          aria-label="Generate & Verify"
          title="Generate & Verify (Cmd/Ctrl + Enter) — runs the deterministic generator and the full verification pipeline"
          onClick={() => {
            void submitTransform();
          }}
        >
          <Play className="h-4 w-4 text-bg-0 fill-current" />
        </button>
        {/* Studio-IDE-13 (#255): explicit Generate Java toolbar action.
            Invokes /api/v0/generate; if any Java buffer holds manual
            edits the confirmation modal opens first so the user can
            consciously proceed into the 3-Way Merge. */}
        <button
          type="button"
          data-testid="topbar-generate-button"
          disabled={!canGenerate}
          className="flex items-center justify-center gap-1 rounded border border-line-2 bg-bg-2 px-2 py-1 text-xs text-text-dim hover:text-text hover:bg-bg-1 disabled:opacity-50 disabled:cursor-not-allowed focus-visible:ring-1 focus-visible:ring-accent outline-none"
          aria-label="Generate Java"
          title="Generate Java — invoke the deterministic generator only"
          onClick={handleGenerate}
        >
          <Wand2 className="h-3.5 w-3.5" />
          <span>Generate</span>
        </button>
        {/* Studio-IDE-13 (#255): Regenerate Java. Same as Generate but
            always confirms via modal first per the issue spec. */}
        <button
          type="button"
          data-testid="topbar-regenerate-button"
          disabled={!canRegenerate}
          className="flex items-center justify-center gap-1 rounded border border-line-2 bg-bg-2 px-2 py-1 text-xs text-text-dim hover:text-text hover:bg-bg-1 disabled:opacity-50 disabled:cursor-not-allowed focus-visible:ring-1 focus-visible:ring-accent outline-none"
          aria-label="Regenerate Java"
          title="Regenerate Java — confirms first, then re-runs the generator"
          onClick={handleRegenerate}
        >
          <RotateCw className="h-3.5 w-3.5" />
          <span>Regenerate</span>
        </button>
        <button
          type="button"
          data-testid="topbar-compile-check-button"
          disabled={!canCompileCheck || compileCheckPending}
          className="flex items-center justify-center gap-1 rounded border border-line-2 bg-bg-2 px-2 py-1 text-xs text-text-dim hover:text-text hover:bg-bg-1 disabled:opacity-50 disabled:cursor-not-allowed focus-visible:ring-1 focus-visible:ring-accent outline-none"
          aria-label="Run Compile Check on the current Java buffer"
          title="Compile Check (F5)"
          onClick={() => triggerCompileCheck()}
        >
          <Hammer className="h-3.5 w-3.5" />
          <span>{compileCheckPending ? "Compile…" : "Compile Check"}</span>
        </button>
        {/* Studio-IDE-13 (#255): Verify action. Runs /api/v0/verify on
            the current Java buffer state; the response stamps the
            manual-edit summary fields per ADR-0007 §4. */}
        <button
          type="button"
          data-testid="topbar-verify-button"
          disabled={!canVerifyCurrentBuffers}
          className="flex items-center justify-center gap-1 rounded border border-line-2 bg-bg-2 px-2 py-1 text-xs text-text-dim hover:text-text hover:bg-bg-1 disabled:opacity-50 disabled:cursor-not-allowed focus-visible:ring-1 focus-visible:ring-accent outline-none"
          aria-label="Verify the current Java buffer"
          title="Verify — run the full build/test/oracle pipeline on the current Java buffer"
          onClick={() => void handleVerifyCurrentBuffers()}
        >
          <ShieldCheck className="h-3.5 w-3.5" />
          <span>{verifyPending ? "Verifying…" : "Verify"}</span>
        </button>
      </div>

      <div className="flex items-center gap-3">
        <div
          className="flex items-center gap-2 text-xs"
          aria-label="Product readiness"
        >
          {readiness.tone === "loading" ? (
            <span className="text-text-dim">{readiness.topBarLabel}</span>
          ) : readiness.tone === "ready" ? (
            <div className="flex items-center gap-1 text-success">
              <CheckCircle2 className="h-4 w-4" />
              <span>{readiness.topBarLabel}</span>
            </div>
          ) : readiness.tone === "warning" ? (
            <div className="flex items-center gap-1 text-warn">
              <AlertCircle className="h-4 w-4" />
              <span>{readiness.topBarLabel}</span>
            </div>
          ) : (
            <div className="flex items-center gap-1 text-error">
              <AlertCircle className="h-4 w-4" />
              <span>{readiness.topBarLabel}</span>
            </div>
          )}
        </div>
        <div className="h-4 w-px bg-line-2"></div>
        <button
          type="button"
          className="p-1 text-text-dim hover:text-text focus-visible:ring-1 focus-visible:ring-accent outline-none rounded"
          aria-label="Search workspace"
        >
          <Search className="h-4 w-4" />
        </button>
        <button
          type="button"
          className="p-1 text-text-dim hover:text-text focus-visible:ring-1 focus-visible:ring-accent outline-none rounded"
          aria-label="Open studio settings"
        >
          <Settings className="h-4 w-4" />
        </button>
        <div ref={menuRef} className="relative">
          <button
            type="button"
            onClick={() => setMenuOpen((open) => !open)}
            className="p-1 text-text-dim hover:text-text focus-visible:ring-1 focus-visible:ring-accent outline-none rounded"
            aria-label="More workbench actions"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
          {menuOpen ? (
            <div
              role="menu"
              className="absolute right-0 top-full z-30 mt-1 w-56 rounded border border-line-2 bg-bg-1 py-1 text-xs shadow-lg"
            >
              <button
                type="button"
                role="menuitem"
                onClick={openClearDraftsDialog}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-text hover:bg-bg-2"
              >
                <Trash2 className="h-3.5 w-3.5 text-text-dim" />
                Clear local drafts
              </button>
            </div>
          ) : null}
        </div>
      </div>

      {feedback ? (
        <div
          role="status"
          aria-live="polite"
          className="absolute right-4 top-14 z-40 rounded border border-line-2 bg-bg-1 px-3 py-1 text-xs text-text shadow"
        >
          {feedback}
        </div>
      ) : null}

      {confirmOpen ? (
        <ClearDraftsConfirmDialog
          onCancel={() => setConfirmOpen(false)}
          onConfirm={onClearDrafts}
          scope={clearDraftsScope}
          draftCount={clearDraftsCount}
          loading={clearDraftsLoading}
          pending={clearDraftsPending}
          error={clearDraftsError}
        />
      ) : null}

      {regenerateConfirmOpen ? (
        <RegenerateConfirmDialog
          hasManualEdits={hasManualEditsAnywhere}
          onCancel={() => setRegenerateConfirmOpen(false)}
          onConfirm={handleConfirmRegenerate}
        />
      ) : null}
    </header>
  );
}

function bucketDraftCount(count: number): "zero" | "lt_10" | "lt_100" | "ge_100" {
  if (count === 0) return "zero";
  if (count < 10) return "lt_10";
  if (count < 100) return "lt_100";
  return "ge_100";
}

function RegenerateConfirmDialog({
  hasManualEdits,
  onCancel,
  onConfirm,
}: {
  hasManualEdits: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    dialogRef.current?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onCancel();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onCancel]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="regenerate-title"
      data-testid="topbar-regenerate-confirm-dialog"
      className="fixed inset-0 z-50 flex items-center justify-center bg-bg-0/80 p-6"
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="w-full max-w-md space-y-4 rounded-lg border border-line-2 bg-bg-1 p-6 outline-none focus:ring-2 focus:ring-accent"
      >
        <h2 id="regenerate-title" className="text-base font-semibold text-text">
          {hasManualEdits
            ? "Re-run the generator with manual edits present?"
            : "Re-run the generator?"}
        </h2>
        <p className="text-sm text-text-dim">
          {hasManualEdits
            ? "Your Java buffer has manual edits. The generator will produce a fresh baseline; if the new output diverges, a 3-Way Merge will open so you can pick per region. Your manual edits will not be silently overwritten."
            : "The generator will produce a fresh baseline for the current COBOL input. Continue?"}
        </p>
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            data-testid="topbar-regenerate-confirm-cancel"
            onClick={onCancel}
            className="rounded border border-line-2 px-3 py-1 text-xs text-text-dim hover:text-text"
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="topbar-regenerate-confirm-proceed"
            onClick={onConfirm}
            className="rounded bg-teal px-3 py-1 text-xs font-medium text-bg-0 hover:bg-teal-soft"
          >
            Run generator
          </button>
        </div>
      </div>
    </div>
  );
}

function ClearDraftsConfirmDialog({
  onCancel,
  onConfirm,
  scope,
  draftCount,
  loading,
  pending,
  error,
}: {
  onCancel: () => void;
  onConfirm: () => void;
  scope: DraftScope | null;
  draftCount: number | null;
  loading: boolean;
  pending: boolean;
  error: string | null;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    dialogRef.current?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onCancel();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onCancel]);

  const scopeLabel = scope
    ? `Tenant ${scope.tenantId} / User ${scope.userId}`
    : "Current signed-in workspace";
  const countLabel =
    draftCount === null
      ? "Checking local drafts…"
      : `${draftCount} local draft${draftCount === 1 ? "" : "s"}`;
  const canConfirm = !loading && !pending && !error && scope !== null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="clear-drafts-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-bg-0/80 p-6"
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="w-full max-w-md space-y-4 rounded-lg border border-line-2 bg-bg-1 p-6 outline-none focus:ring-2 focus:ring-accent"
      >
        <h2
          id="clear-drafts-title"
          className="text-base font-semibold text-text"
        >
          Clear local drafts?
        </h2>
        <p className="text-sm text-text-dim">
          This removes every locally saved COBOL and Java draft for this
          workspace from your browser. The backend copies and any committed runs
          are not affected. This action cannot be undone.
        </p>
        <div className="rounded border border-line-2 bg-bg-2 px-3 py-2 text-xs text-text-dim">
          <div>
            Scope: <span className="font-medium text-text">{scopeLabel}</span>
          </div>
          <div>
            Drafts: <span className="font-medium text-text">{countLabel}</span>
          </div>
          {error ? <div className="mt-2 text-error">{error}</div> : null}
        </div>
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={pending}
            className="rounded border border-line-2 px-3 py-1 text-xs text-text-dim hover:text-text"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={!canConfirm}
            className="rounded bg-error px-3 py-1 text-xs font-medium text-bg-0 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pending ? "Clearing…" : "Clear drafts"}
          </button>
        </div>
      </div>
    </div>
  );
}
