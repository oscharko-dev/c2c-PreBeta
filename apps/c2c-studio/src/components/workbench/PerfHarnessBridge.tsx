"use client";

// Studio-IDE-12 (#250) §Performance / E2E test seam: lets browser
// harnesses drive the workbench from outside (load a COBOL fixture into
// the COBOL editor pane and trigger Monaco actions) without threading
// test-only props through every store.
//
// Activated only in explicit harness builds when
// ``process.env.NEXT_PUBLIC_C2C_PERF_HARNESS === "1"`` or
// ``process.env.NEXT_PUBLIC_C2C_E2E_HARNESS === "1"``. The hook renders
// ``null`` in every other build so production users never pay the cost of the
// listener / global it installs.
//
// Hooks installed when active:
//
//   * ``window.addEventListener("c2c-perf:load-cobol", ev)`` →
//     calls ``setSourceFile(detail.sourceText, detail.sourceName)`` without
//     local-draft restoration so the perf gate measures editor churn rather
//     than session-bootstrap / IndexedDB noise.
//   * ``window.addEventListener("c2c-e2e:load-cobol", ev)`` →
//     calls ``setSourceFile(detail.sourceText, detail.sourceName)`` with the
//     same draft-restore bypass as the perf event.
//   * ``window.addEventListener("c2c-perf:clear-editors", ev)`` →
//     calls ``clearWorkspace()`` to reset to the empty state.
//   * ``window.__c2cEditorHarnessReady`` → boolean readiness flag for
//     Playwright helpers so they do not dispatch before the effect mounts.
//   * ``window.__c2cMonacoEditor`` → the latest mounted
//     ``IStandaloneCodeEditor`` instance, refreshed whenever a Monaco
//     editor mounts.
//   * ``window.__c2cMonacoModelCount`` / ``__c2cMonacoModelUris`` →
//     browser-only probes used by the @memory gate to verify model disposal.
//
// The hooks deliberately use plain DOM CustomEvents so the perf
// harness can drive them without importing Studio code.

import { useEffect } from "react";

import { useSourceWorkspace } from "../../stores/sourceWorkspace";

const EDITOR_HARNESS_ENABLED =
  process.env.NEXT_PUBLIC_C2C_PERF_HARNESS === "1" ||
  process.env.NEXT_PUBLIC_C2C_E2E_HARNESS === "1";

interface LoadCobolDetail {
  sourceText: string;
  sourceName?: string;
}

export function PerfHarnessBridge() {
  const { setSourceFile, clearWorkspace } = useSourceWorkspace();

  useEffect(() => {
    if (!EDITOR_HARNESS_ENABLED) return;
    if (typeof window === "undefined") return;

    (
      window as unknown as {
        __c2cEditorHarnessReady?: boolean;
      }
    ).__c2cEditorHarnessReady = true;

    const onLoad = (event: Event) => {
      const detail = (event as CustomEvent<LoadCobolDetail>).detail;
      if (!detail || typeof detail.sourceText !== "string") return;
      const sourceName = detail.sourceName ?? "perf-harness.cbl";
      setSourceFile(detail.sourceText, sourceName, `perf:${sourceName}`, {
        restoreDraft: false,
      });
    };
    const onClear = () => clearWorkspace();

    window.addEventListener("c2c-perf:load-cobol", onLoad);
    window.addEventListener("c2c-e2e:load-cobol", onLoad);
    window.addEventListener("c2c-perf:clear-editors", onClear);
    window.addEventListener("c2c-e2e:clear-editors", onClear);
    return () => {
      window.removeEventListener("c2c-perf:load-cobol", onLoad);
      window.removeEventListener("c2c-e2e:load-cobol", onLoad);
      window.removeEventListener("c2c-perf:clear-editors", onClear);
      window.removeEventListener("c2c-e2e:clear-editors", onClear);
      (
        window as unknown as {
          __c2cEditorHarnessReady?: boolean;
        }
      ).__c2cEditorHarnessReady = false;
    };
  }, [setSourceFile, clearWorkspace]);

  return null;
}
