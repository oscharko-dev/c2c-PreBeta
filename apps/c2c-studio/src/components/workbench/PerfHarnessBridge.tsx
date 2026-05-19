"use client";

// Studio-IDE-12 (#250) §Performance test seam: lets the
// ``tests/e2e/perf.spec.ts`` harness drive the workbench from outside
// (load a large COBOL fixture into the COBOL editor pane and trigger
// Monaco actions) without having to thread test-only props through
// every store.
//
// Activated only when
// ``process.env.NEXT_PUBLIC_C2C_PERF_HARNESS === "1"``. The hook
// renders ``null`` in every other build so production users never
// pay the cost of the listener / global it installs.
//
// Hooks installed when active:
//
//   * ``window.addEventListener("c2c-perf:load-cobol", ev)`` →
//     calls ``setSourceFile(detail.sourceText, "perf-harness.cbl")``.
//   * ``window.addEventListener("c2c-perf:clear-editors", ev)`` →
//     calls ``clearWorkspace()`` to reset to the empty state.
//   * ``window.__c2cMonacoEditor`` → the focused
//     ``IStandaloneCodeEditor`` instance, refreshed whenever a Monaco
//     editor mounts (CodeEditorInner emits a ``c2c:editor-mounted``
//     event the bridge listens to).
//
// The hooks deliberately use plain DOM CustomEvents so the perf
// harness can drive them without importing Studio code.

import { useEffect } from "react";

import { useSourceWorkspace } from "../../stores/sourceWorkspace";

const PERF_HARNESS_ENABLED = process.env.NEXT_PUBLIC_C2C_PERF_HARNESS === "1";

interface LoadCobolDetail {
  sourceText: string;
  sourceName?: string;
}

export function PerfHarnessBridge() {
  const { setSourceFile, clearWorkspace } = useSourceWorkspace();

  useEffect(() => {
    if (!PERF_HARNESS_ENABLED) return;
    if (typeof window === "undefined") return;

    const onLoad = (event: Event) => {
      const detail = (event as CustomEvent<LoadCobolDetail>).detail;
      if (!detail || typeof detail.sourceText !== "string") return;
      const sourceName = detail.sourceName ?? "perf-harness.cbl";
      setSourceFile(detail.sourceText, sourceName, `perf:${sourceName}`);
    };
    const onClear = () => clearWorkspace();

    window.addEventListener("c2c-perf:load-cobol", onLoad);
    window.addEventListener("c2c-perf:clear-editors", onClear);
    return () => {
      window.removeEventListener("c2c-perf:load-cobol", onLoad);
      window.removeEventListener("c2c-perf:clear-editors", onClear);
    };
  }, [setSourceFile, clearWorkspace]);

  return null;
}
