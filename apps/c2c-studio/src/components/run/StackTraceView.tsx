"use client";

// Studio-IDE-8 (#253): render a JVM stack trace as a list of clickable
// frame rows. Each row carries a "Reveal in COBOL" link when the
// Slice 6 (#248) lineage envelope can resolve the frame's Java
// location to a deterministic / agent / repair-attempted region, and
// an "Open Java target" link when the envelope at least knows the full
// Java path. Non-resolvable frames render as inactive monospace text
// with an explicit tooltip. The raw trace is always preserved behind
// a toggle so the user can copy or inspect non-frame lines.

import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import { apiClient } from "@/lib/apiClient";
import { emit as emitTelemetry } from "@/lib/editor/editorTelemetry";
import {
  mapStackFrames,
  parseStackTrace,
  type JavaSourceProvider,
  type ResolvedStackFrame,
} from "@/lib/editor/stackTraceMapper";

// Window-event contract with the editor panes. The COBOL pane (#248)
// already listens for `c2c:reveal-cobol`; the Java pane listener is
// added in this slice (#253) to mirror the bidirectional contract.
const REVEAL_COBOL_EVENT = "c2c:reveal-cobol" as const;
const REVEAL_JAVA_EVENT = "c2c:reveal-java" as const;

interface RevealCobolDetail {
  cobolFile: string;
  cobolLine: number;
}

interface RevealJavaDetail {
  javaFile: string;
  javaLine: number;
}

export interface StackTraceViewProps {
  /** Raw stack trace text from the build/test failure surface. */
  raw: string | null | undefined;
  /**
   * Active runId. The lineage envelope is keyed by runId; without
   * one the view degrades to non-clickable frame rows.
   */
  runId: string | null | undefined;
  /**
   * Optional source provider override — production callers leave it
   * undefined and the view wires the BFF-backed apiClient. Tests pass
   * an in-memory provider to avoid network coupling.
   */
  sourceProvider?: JavaSourceProvider;
  /** Test seam for fetcher injection (passed through to the mapper). */
  fetcher?: typeof fetch;
}

const NO_MAPPING_TOOLTIP = "No source mapping available for this frame";

function defaultSourceProvider(runId: string): JavaSourceProvider {
  return async (javaFilePath: string) => {
    const result = await apiClient.getGeneratedFile(runId, javaFilePath);
    if (result.ok) {
      return result.data.content;
    }
    return null;
  };
}

function dispatchRevealCobol(detail: RevealCobolDetail) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<RevealCobolDetail>(REVEAL_COBOL_EVENT, { detail }),
  );
}

function dispatchRevealJava(detail: RevealJavaDetail) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<RevealJavaDetail>(REVEAL_JAVA_EVENT, { detail }),
  );
}

type LoadState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; frames: ResolvedStackFrame[] }
  | { kind: "error"; message: string };

export function StackTraceView({
  raw,
  runId,
  sourceProvider,
  fetcher,
}: StackTraceViewProps) {
  const parsedFrames = useMemo(() => parseStackTrace(raw ?? ""), [raw]);
  const fallbackFrames = useMemo<ResolvedStackFrame[]>(
    () => parsedFrames.map((frame) => ({ ...frame })),
    [parsedFrames],
  );
  const [state, setState] = useState<LoadState>(() =>
    parsedFrames.length === 0 ? { kind: "idle" } : { kind: "loading" },
  );
  const [showRaw, setShowRaw] = useState(false);

  useEffect(() => {
    if (parsedFrames.length === 0) {
      setState({ kind: "idle" });
      return;
    }
    if (!runId) {
      // No runId — surface frame rows without lineage. The view layer
      // still benefits from the per-frame parsing (class/method
      // labels) even when the COBOL anchor cannot be resolved.
      setState({
        kind: "ready",
        frames: fallbackFrames,
      });
      return;
    }
    let cancelled = false;
    setState({ kind: "loading" });
    const provider = sourceProvider ?? defaultSourceProvider(runId);
    void mapStackFrames(runId, parsedFrames, provider, fetcher).then(
      (resolved) => {
        if (cancelled) return;
        setState({ kind: "ready", frames: resolved });
      },
      (err: unknown) => {
        if (cancelled) return;
        const message =
          err instanceof Error ? err.message : "Failed to map stack trace";
        setState({ kind: "error", message });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [fallbackFrames, parsedFrames, runId, sourceProvider, fetcher]);

  const toggleRaw = useCallback(() => setShowRaw((value) => !value), []);
  const handleRevealCobol = useCallback((frame: ResolvedStackFrame) => {
    if (!frame.cobol) return;
    // Studio-IDE-11 (#251): stacktrace.frame_click → resolved=true.
    // Only the resolution boolean ships; no file paths or line numbers
    // appear in the telemetry payload.
    emitTelemetry({
      eventType: "stacktrace.frame_click",
      payload: { resolved: true },
    });
    dispatchRevealCobol({
      cobolFile: frame.cobol.file,
      cobolLine: frame.cobol.line,
    });
  }, []);
  const handleOpenJava = useCallback((frame: ResolvedStackFrame) => {
    if (!frame.javaFilePath) return;
    emitTelemetry({
      eventType: "stacktrace.frame_click",
      payload: { resolved: Boolean(frame.cobol) },
    });
    dispatchRevealJava({
      javaFile: frame.javaFilePath,
      javaLine: frame.javaLine,
    });
  }, []);

  // No parsed frames AND no raw input → render nothing.
  if (parsedFrames.length === 0 && !(raw && raw.trim().length > 0)) {
    return null;
  }

  // No parsed frames but raw text exists → preserve the original
  // pre-#253 rendering (whitespace-pre-wrap monospace) so non-trace
  // failure notes keep their shape.
  if (parsedFrames.length === 0 && raw && raw.trim().length > 0) {
    return (
      <div
        data-testid="stack-trace-view"
        className="mt-4 rounded border border-line-2 bg-bg-2 p-3 text-xs font-mono text-error whitespace-pre-wrap break-words"
      >
        {raw}
      </div>
    );
  }

  return (
    <div
      data-testid="stack-trace-view"
      className="mt-4 rounded border border-line-2 bg-bg-2"
    >
      <div className="flex items-center justify-between gap-2 border-b border-line-2 px-3 py-2">
        <div className="flex items-center gap-2 text-xs">
          <span className="font-medium text-error">Stack trace</span>
          <span className="text-text-dim">
            {parsedFrames.length}{" "}
            {parsedFrames.length === 1 ? "frame" : "frames"}
          </span>
          {state.kind === "loading" ? (
            <span className="text-text-faint">resolving lineage…</span>
          ) : null}
          {state.kind === "error" ? (
            <span className="text-warn" title={state.message}>
              lineage unavailable
            </span>
          ) : null}
        </div>
        <button
          type="button"
          onClick={toggleRaw}
          aria-expanded={showRaw}
          aria-controls="stack-trace-raw"
          className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] text-text-dim hover:bg-bg-3 hover:text-text focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        >
          {showRaw ? (
            <ChevronDown className="w-3 h-3" />
          ) : (
            <ChevronRight className="w-3 h-3" />
          )}
          {showRaw ? "Hide raw" : "Show raw"}
        </button>
      </div>

      <ul
        role="list"
        aria-label="Stack frames"
        className="divide-y divide-line-2"
      >
        {(state.kind === "ready" ? state.frames : fallbackFrames).map(
          (frame, index) => (
            <StackFrameRow
              key={`${frame.javaFile}:${frame.javaLine}:${index}`}
              frame={frame}
              loading={state.kind === "loading"}
              onRevealCobol={handleRevealCobol}
              onOpenJava={handleOpenJava}
            />
          ),
        )}
      </ul>

      {showRaw && raw ? (
        <pre
          id="stack-trace-raw"
          className="m-0 border-t border-line-2 bg-bg-1 px-3 py-2 text-[11px] font-mono text-text-dim whitespace-pre-wrap break-words"
        >
          {raw}
        </pre>
      ) : null}
    </div>
  );
}

interface StackFrameRowProps {
  frame: ResolvedStackFrame;
  loading: boolean;
  onRevealCobol: (frame: ResolvedStackFrame) => void;
  onOpenJava: (frame: ResolvedStackFrame) => void;
}

function StackFrameRow({
  frame,
  loading,
  onRevealCobol,
  onOpenJava,
}: StackFrameRowProps) {
  const cobolResolved = frame.cobol !== undefined;
  const javaPathKnown = frame.javaFilePath !== undefined;
  const inactiveTooltip = cobolResolved ? undefined : NO_MAPPING_TOOLTIP;
  return (
    <li
      className="px-3 py-2 text-xs font-mono"
      data-testid="stack-frame-row"
      data-resolved={cobolResolved ? "true" : "false"}
      aria-label={
        cobolResolved
          ? undefined
          : `${frame.className}.${frame.methodName} (${frame.javaFile}:${frame.javaLine}). ${NO_MAPPING_TOOLTIP}`
      }
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span
          className={cobolResolved ? "text-text" : "text-text-dim italic"}
          title={inactiveTooltip}
          aria-label={
            cobolResolved
              ? undefined
              : `${frame.className}.${frame.methodName}. ${NO_MAPPING_TOOLTIP}`
          }
        >
          {frame.className}
          <span className="text-text-faint">.</span>
          {frame.methodName}
        </span>
        <span className="text-text-faint">
          ({frame.javaFile}:{frame.javaLine})
        </span>
        {cobolResolved && frame.cobol ? (
          <button
            type="button"
            onClick={() => onRevealCobol(frame)}
            disabled={loading}
            aria-label={`Reveal COBOL line ${frame.cobol.line} in ${frame.cobol.file}`}
            className="inline-flex items-center gap-1 rounded border border-accent/30 bg-accent/10 px-2 py-0.5 text-[11px] font-medium text-accent hover:bg-accent/20 focus:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-50"
          >
            → COBOL {frame.cobol.file}:{frame.cobol.line}
          </button>
        ) : (
          <span
            className="inline-flex items-center rounded border border-line-2 bg-bg-1 px-2 py-0.5 text-[11px] text-text-faint"
            title={NO_MAPPING_TOOLTIP}
            aria-label={NO_MAPPING_TOOLTIP}
          >
            no source mapping
          </span>
        )}
        {cobolResolved && javaPathKnown ? (
          <button
            type="button"
            onClick={() => onOpenJava(frame)}
            disabled={loading}
            aria-label={`Open Java file ${frame.javaFilePath} at line ${frame.javaLine}`}
            className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] text-text-dim hover:bg-bg-3 hover:text-text focus:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-50"
          >
            Open Java target
          </button>
        ) : null}
      </div>
    </li>
  );
}
