"use client";

import type * as MonacoNs from "monaco-editor";

export type Monaco = typeof MonacoNs;

// Monaco's worker bootstrap reads `self.MonacoEnvironment` at runtime; the
// global declaration is shipped by monaco-editor itself (Environment).
type MonacoEnvironmentLike = NonNullable<
  (typeof globalThis)["MonacoEnvironment"]
>;

let monacoPromise: Promise<Monaco> | null = null;

export function getMonaco(): Promise<Monaco> {
  if (typeof window === "undefined") {
    return Promise.reject(
      new Error("Monaco can only be loaded in the browser."),
    );
  }
  if (!monacoPromise) {
    monacoPromise = loadMonaco();
  }
  return monacoPromise;
}

// Exposed for tests; resets the cached promise so that the next call re-runs the loader.
export function __resetMonacoForTests(): void {
  monacoPromise = null;
  if (typeof self !== "undefined") {
    delete (self as { MonacoEnvironment?: MonacoEnvironmentLike })
      .MonacoEnvironment;
  }
}

async function loadMonaco(): Promise<Monaco> {
  configureMonacoEnvironment();
  const monaco = await import("monaco-editor/esm/vs/editor/editor.api");
  await Promise.all([
    import("monaco-editor/esm/vs/basic-languages/java/java.contribution"),
    import("monaco-editor/esm/vs/basic-languages/xml/xml.contribution"),
    import("monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution"),
    import("monaco-editor/esm/vs/language/json/monaco.contribution"),
  ]);
  return monaco;
}

function configureMonacoEnvironment(): void {
  if (typeof self === "undefined") {
    return;
  }
  if (self.MonacoEnvironment) {
    return;
  }
  self.MonacoEnvironment = {
    getWorker(_workerId: string, label: string): Worker {
      if (label === "json") {
        return new Worker(
          new URL(
            "monaco-editor/esm/vs/language/json/json.worker.js",
            import.meta.url,
          ),
          { type: "module" },
        );
      }
      return new Worker(
        new URL(
          "monaco-editor/esm/vs/editor/editor.worker.js",
          import.meta.url,
        ),
        { type: "module" },
      );
    },
  };
}
