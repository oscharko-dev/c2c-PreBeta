"use client";

import type * as MonacoNs from "monaco-editor";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { X } from "lucide-react";

import { CodeEditor } from "@/components/editor/CodeEditor";
import type { DiffEditorMountArgs } from "@/components/editor/CodeEditor";
import { detectLanguageFromPath } from "@/lib/editor/languageDetection";
import {
  buildTrustPillarDecorations,
  mergeRegionsForTrustPillars,
} from "@/lib/editor/trustPillars";
import type { JavaOriginOverlay, JavaRegionClassification } from "@/types/api";

export interface ManualDriftWorkspaceProps {
  filePath: string;
  runId: string;
  baselineRunId: string | null;
  baselineContent: string | null;
  currentContent: string;
  manualOverlay: JavaOriginOverlay | null;
  initialFocusLine?: number | null;
  onClose: () => void;
}

function jumpToHunk(
  editor: MonacoNs.editor.IStandaloneDiffEditor,
  direction: "next" | "prev",
): void {
  const changes = editor.getLineChanges();
  if (!changes || changes.length === 0) return;
  const modified = editor.getModifiedEditor();
  const currentLine = modified.getPosition()?.lineNumber ?? 0;
  const target =
    direction === "next"
      ? changes.find((change) => change.modifiedStartLineNumber > currentLine) ??
        changes[0]
      : [...changes]
          .reverse()
          .find(
            (change) =>
              (change.modifiedEndLineNumber ||
                change.modifiedStartLineNumber) < currentLine,
          ) ?? changes[changes.length - 1];
  if (!target) return;
  const line = Math.max(1, target.modifiedStartLineNumber);
  modified.revealLineInCenter(line);
  modified.setPosition({ lineNumber: line, column: 1 });
  modified.focus();
}

function clampManualRegionToOriginal(
  region: JavaRegionClassification,
  lineCount: number,
): JavaRegionClassification | null {
  if (lineCount <= 0) return null;
  if (region.originClass !== "manual_modified") return null;
  const startLine = Math.max(1, Math.min(lineCount, region.lineRange.startLine));
  const endLine = Math.max(
    startLine,
    Math.min(lineCount, region.lineRange.endLine),
  );
  return { ...region, lineRange: { startLine, endLine } };
}

function EmptyManualDriftShell({
  filePath,
  onClose,
}: {
  filePath: string;
  onClose: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="manual-drift-title"
      data-testid="manual-drift-workspace-empty"
      className="fixed inset-0 z-40 flex flex-col bg-bg-0/95 backdrop-blur-sm"
    >
      <div className="flex shrink-0 items-center justify-between border-b border-line bg-bg-1 px-4 py-2">
        <h2
          id="manual-drift-title"
          className="truncate text-sm font-medium text-text"
        >
          Manual Drift - {filePath.split("/").pop()}
        </h2>
        <button
          type="button"
          aria-label="Close manual drift"
          onClick={onClose}
          className="rounded p-1 text-text-dim hover:bg-bg-2 hover:text-text"
        >
          <X size={16} />
        </button>
      </div>
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-text-dim">
        <p className="text-sm">
          No Generator Baseline exists for this file yet.
        </p>
        <p className="text-xs">
          Generate or regenerate Java once, then reopen Manual Drift to compare
          that baseline with the current buffer.
        </p>
      </div>
    </div>
  );
}

export function ManualDriftWorkspace({
  filePath,
  runId,
  baselineRunId,
  baselineContent,
  currentContent,
  manualOverlay,
  initialFocusLine,
  onClose,
}: ManualDriftWorkspaceProps) {
  if (baselineRunId === null || baselineContent === null) {
    return <EmptyManualDriftShell filePath={filePath} onClose={onClose} />;
  }

  return (
    <ManualDriftWorkspaceBody
      filePath={filePath}
      runId={runId}
      baselineRunId={baselineRunId}
      baselineContent={baselineContent}
      currentContent={currentContent}
      manualOverlay={manualOverlay}
      initialFocusLine={initialFocusLine ?? null}
      onClose={onClose}
    />
  );
}

interface ManualDriftWorkspaceBodyProps
  extends Omit<
    ManualDriftWorkspaceProps,
    "baselineRunId" | "baselineContent" | "initialFocusLine"
  > {
  baselineRunId: string;
  baselineContent: string;
  initialFocusLine: number | null;
}

function ManualDriftWorkspaceBody({
  filePath,
  runId,
  baselineRunId,
  baselineContent,
  currentContent,
  manualOverlay,
  initialFocusLine,
  onClose,
}: ManualDriftWorkspaceBodyProps) {
  const language = useMemo(() => detectLanguageFromPath(filePath), [filePath]);
  const diffEditorRef =
    useRef<MonacoNs.editor.IStandaloneDiffEditor | null>(null);
  const monacoRef = useRef<DiffEditorMountArgs["monaco"] | null>(null);
  const originalDecorationsRef =
    useRef<MonacoNs.editor.IEditorDecorationsCollection | null>(null);
  const modifiedDecorationsRef =
    useRef<MonacoNs.editor.IEditorDecorationsCollection | null>(null);
  const disposablesRef = useRef<MonacoNs.IDisposable[]>([]);

  const manualRegions = useMemo(
    () =>
      mergeRegionsForTrustPillars({
        traceabilityOverlay: null,
        manualOverlay,
      }),
    [manualOverlay],
  );

  const applyDecorations = useCallback(() => {
    const editor = diffEditorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco) return;

    const modifiedDecorations =
      manualRegions.length > 0
        ? buildTrustPillarDecorations({
            monaco,
            regions: manualRegions,
            manualEditCount: manualRegions.length,
          })
        : [];
    const originalLineCount =
      editor.getOriginalEditor().getModel()?.getLineCount() ?? 0;
    const originalRegions = manualRegions.flatMap((region) => {
      const clamped = clampManualRegionToOriginal(region, originalLineCount);
      return clamped ? [clamped] : [];
    });
    const originalDecorations =
      originalRegions.length > 0
        ? buildTrustPillarDecorations({
            monaco,
            regions: originalRegions,
            manualEditCount: manualRegions.length,
          })
        : [];

    if (modifiedDecorationsRef.current) {
      modifiedDecorationsRef.current.set(modifiedDecorations);
    } else {
      modifiedDecorationsRef.current = editor
        .getModifiedEditor()
        .createDecorationsCollection(modifiedDecorations);
    }

    if (originalDecorationsRef.current) {
      originalDecorationsRef.current.set(originalDecorations);
    } else {
      originalDecorationsRef.current = editor
        .getOriginalEditor()
        .createDecorationsCollection(originalDecorations);
    }
  }, [manualRegions]);

  const trackDisposable = useCallback(
    (disposable: MonacoNs.IDisposable | string | null) => {
      if (
        disposable &&
        typeof disposable !== "string" &&
        typeof disposable.dispose === "function"
      ) {
        disposablesRef.current.push(disposable);
      }
    },
    [],
  );

  const handleMount = useCallback(
    ({ editor, monaco }: DiffEditorMountArgs) => {
      diffEditorRef.current = editor;
      monacoRef.current = monaco;
      const modified = editor.getModifiedEditor();
      const original = editor.getOriginalEditor();
      const goNext = () => jumpToHunk(editor, "next");
      const goPrev = () => jumpToHunk(editor, "prev");
      trackDisposable(modified.addCommand(monaco.KeyCode.F7, goNext));
      trackDisposable(
        modified.addCommand(monaco.KeyMod.Shift | monaco.KeyCode.F7, goPrev),
      );
      trackDisposable(original.addCommand(monaco.KeyCode.F7, goNext));
      trackDisposable(
        original.addCommand(monaco.KeyMod.Shift | monaco.KeyCode.F7, goPrev),
      );
      applyDecorations();

      if (initialFocusLine !== null) {
        const line = Math.max(1, initialFocusLine);
        modified.revealLineInCenter(line);
        modified.setPosition({ lineNumber: line, column: 1 });
        modified.focus();
      }
    },
    [applyDecorations, initialFocusLine, trackDisposable],
  );

  useEffect(() => {
    applyDecorations();
  }, [applyDecorations]);

  useEffect(() => {
    return () => {
      originalDecorationsRef.current?.clear();
      modifiedDecorationsRef.current?.clear();
      originalDecorationsRef.current = null;
      modifiedDecorationsRef.current = null;
      for (const disposable of disposablesRef.current) {
        try {
          disposable.dispose();
        } catch {
          // Monaco owns editor teardown; cleanup remains best-effort.
        }
      }
      disposablesRef.current = [];
    };
  }, []);

  const originalModelUri = useMemo(
    () =>
      `inmemory://c2c-studio/diff/manual-drift/${baselineRunId}/${filePath}~original`,
    [baselineRunId, filePath],
  );
  const modelUri = useMemo(
    () =>
      `inmemory://c2c-studio/diff/manual-drift/${runId}/${filePath}~modified`,
    [runId, filePath],
  );

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="manual-drift-title"
      data-testid="manual-drift-workspace"
      className="fixed inset-0 z-40 flex flex-col bg-bg-0/95 backdrop-blur-sm"
    >
      <div className="flex shrink-0 items-center justify-between border-b border-line bg-bg-1 px-4 py-2">
        <div className="flex items-center gap-2 overflow-hidden">
          <h2
            id="manual-drift-title"
            className="truncate text-sm font-medium text-text"
          >
            Manual Drift - {filePath.split("/").pop()}
          </h2>
          <span className="truncate text-xs text-text-dim">{filePath}</span>
        </div>
        <div className="flex items-center gap-2">
          <span
            className="hidden text-[10px] text-text-dim md:inline"
            title="F7 jumps to the next hunk; Shift+F7 jumps to the previous hunk."
          >
            F7 next - Shift+F7 prev
          </span>
          <button
            type="button"
            aria-label="Close manual drift"
            onClick={onClose}
            className="rounded p-1 text-text-dim hover:bg-bg-2 hover:text-text"
          >
            <X size={16} />
          </button>
        </div>
      </div>

      {manualRegions.length === 0 ? (
        <div
          role="status"
          aria-live="polite"
          data-testid="manual-drift-clean-notice"
          className="shrink-0 border-b border-success/20 bg-success-soft px-4 py-1.5 text-xs text-success"
        >
          No manual drift detected - current buffer matches the Generator
          Baseline.
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="shrink-0 bg-bg-1 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-text-dim">
          Generator Baseline (run {baselineRunId.slice(0, 8)}) - Current Java
          Buffer
        </div>
        <div className="min-h-0 flex-1" data-testid="manual-drift-editor">
          <CodeEditor
            mode="diff"
            language={language}
            original={baselineContent}
            value={currentContent}
            modelUri={modelUri}
            originalModelUri={originalModelUri}
            ariaLabel={`Manual drift diff for ${filePath}`}
            onMount={handleMount}
            className="h-full"
          />
        </div>
      </div>
    </div>
  );
}
