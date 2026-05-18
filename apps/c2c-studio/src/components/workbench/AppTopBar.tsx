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
} from "lucide-react";
import { type StudioApiState } from "../../hooks/useC2cApi";
import { getWorkbenchReadiness } from "./workbenchReadiness";
import { useSourceWorkspace } from "../../stores/sourceWorkspace";
import { useKeyboardShortcuts } from "../../hooks/useKeyboardShortcuts";
import { AppLogo } from "../icons/AppLogo";
import {
  editorPersistence,
  getCurrentDraftScope,
} from "../../lib/editor/editorPersistence";
import { useJavaEditorActions } from "../../stores/javaEditorActions";

interface AppTopBarProps {
  apiState: StudioApiState;
}

export function AppTopBar({ apiState }: AppTopBarProps) {
  const { loading } = apiState;
  const readiness = getWorkbenchReadiness(apiState);
  const { canSubmitTransform, submitTransform } = useSourceWorkspace();
  const canStart = readiness.startEnabled && !loading && canSubmitTransform;
  // Studio-IDE-14 (#256): Compile Check is rendered as a sibling of the
  // Start button. The Java editor pane registers an imperative handler
  // through the JavaEditorActionsProvider; when no pane is mounted the
  // button stays disabled.
  const { canCompileCheck, compileCheckPending, triggerCompileCheck } =
    useJavaEditorActions();

  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

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

  const onClearDrafts = useCallback(async () => {
    const scope = getCurrentDraftScope();
    const result = await editorPersistence.clearAll(scope);
    setConfirmOpen(false);
    setFeedback(
      result.purgedCount === 0
        ? "No local drafts to clear."
        : `Cleared ${result.purgedCount} local draft${result.purgedCount === 1 ? "" : "s"}.`,
    );
    setTimeout(() => setFeedback(null), 4000);
  }, []);

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
          disabled={!canStart}
          className="flex items-center justify-center rounded bg-teal hover:bg-teal-soft active:bg-teal disabled:opacity-50 disabled:cursor-not-allowed p-1.5 focus-visible:ring-1 focus-visible:ring-accent outline-none"
          aria-label="Start Transformation"
          title="Start Transformation (Cmd/Ctrl + Enter)"
          onClick={() => {
            void submitTransform();
          }}
        >
          <Play className="h-4 w-4 text-bg-0 fill-current" />
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
                onClick={() => {
                  setMenuOpen(false);
                  setConfirmOpen(true);
                }}
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
        />
      ) : null}
    </header>
  );
}

function ClearDraftsConfirmDialog({
  onCancel,
  onConfirm,
}: {
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
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded border border-line-2 px-3 py-1 text-xs text-text-dim hover:text-text"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="rounded bg-error px-3 py-1 text-xs font-medium text-bg-0 hover:opacity-90"
          >
            Clear drafts
          </button>
        </div>
      </div>
    </div>
  );
}
