"use client";

import type * as MonacoNs from "monaco-editor";

export type Monaco = typeof MonacoNs;

// Monaco's worker bootstrap reads `self.MonacoEnvironment` at runtime; the
// global declaration is shipped by monaco-editor itself (Environment).
type MonacoEnvironmentLike = NonNullable<
  (typeof globalThis)["MonacoEnvironment"]
>;

let monacoPromise: Promise<Monaco> | null = null;
// Studio-IDE-5 (#244): cached Monaco instance for callers that only
// run after the async loader has resolved. `getMonacoSync` returns
// null until the promise resolves so callers can fall back to a
// no-op marker render rather than blocking on async import.
let monacoCache: Monaco | null = null;
type MonacoLanguageContribution = "java" | "json" | "markdown" | "xml";

const languageContributionLoaders: Record<
  MonacoLanguageContribution,
  () => Promise<unknown>
> = {
  java: () =>
    import("monaco-editor/esm/vs/basic-languages/java/java.contribution"),
  json: () => import("monaco-editor/esm/vs/language/json/monaco.contribution"),
  markdown: () =>
    import(
      "monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution"
    ),
  xml: () =>
    import("monaco-editor/esm/vs/basic-languages/xml/xml.contribution"),
};

const loadedLanguageContributions = new Set<MonacoLanguageContribution>();
const languageContributionPromises = new Map<
  MonacoLanguageContribution,
  Promise<unknown>
>();

export function getMonacoSync(): Monaco | null {
  return monacoCache;
}

export async function getMonaco(
  language?: string | readonly string[],
): Promise<Monaco> {
  if (typeof window === "undefined") {
    return Promise.reject(
      new Error("Monaco can only be loaded in the browser."),
    );
  }
  if (!monacoPromise) {
    monacoPromise = loadMonaco();
  }
  const monaco = await monacoPromise;
  await ensureLanguageContributions(language);
  return monaco;
}

// Exposed for tests; resets the cached promise so that the next call re-runs the loader.
export function __resetMonacoForTests(): void {
  monacoPromise = null;
  monacoCache = null;
  loadedLanguageContributions.clear();
  languageContributionPromises.clear();
  if (typeof self !== "undefined") {
    delete (self as { MonacoEnvironment?: MonacoEnvironmentLike })
      .MonacoEnvironment;
  }
}

async function loadMonaco(): Promise<Monaco> {
  configureMonacoEnvironment();
  const monaco = await import("monaco-editor/esm/vs/editor/editor.api");
  monacoCache = monaco;
  return monaco;
}

async function ensureLanguageContributions(
  language?: string | readonly string[],
): Promise<void> {
  const contributions = normalizeLanguageContributions(language);
  if (contributions.length === 0) {
    return;
  }
  await Promise.all(
    contributions.map((contribution) => {
      if (loadedLanguageContributions.has(contribution)) {
        return Promise.resolve();
      }
      const existing = languageContributionPromises.get(contribution);
      if (existing) {
        return existing;
      }
      const promise = languageContributionLoaders[contribution]().then(
        (module) => {
          loadedLanguageContributions.add(contribution);
          return module;
        },
      );
      languageContributionPromises.set(contribution, promise);
      return promise;
    }),
  );
}

function normalizeLanguageContributions(
  language?: string | readonly string[],
): MonacoLanguageContribution[] {
  const requested = Array.isArray(language)
    ? language
    : language
      ? [language]
      : [];
  const contributions = new Set<MonacoLanguageContribution>();
  for (const item of requested) {
    switch (item.toLowerCase()) {
      case "java":
        contributions.add("java");
        break;
      case "json":
        contributions.add("json");
        break;
      case "markdown":
        contributions.add("markdown");
        break;
      case "xml":
        contributions.add("xml");
        break;
    }
  }
  return [...contributions];
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

// Studio-IDE-5 (#244 review): React hook that returns the Monaco
// instance (or null) and triggers a re-render once it resolves. Use
// this in panes that derive marker groups from the typed Diagnostic
// state — without it, the initial render happens before Monaco has
// loaded and the marker memo caches an empty result indefinitely.
import { useEffect, useState } from "react";

export function useMonacoReady(enabled = true): Monaco | null {
  const [monaco, setMonaco] = useState<Monaco | null>(() => monacoCache);
  useEffect(() => {
    if (!enabled) return;
    if (monaco) return;
    if (monacoCache) {
      setMonaco(monacoCache);
      return;
    }
    let cancelled = false;
    getMonaco()
      .then((instance) => {
        if (!cancelled) setMonaco(instance);
      })
      .catch(() => {
        // Editor surfaces load failures via its own error UI; this
        // hook keeps `null` so the marker memo simply falls through.
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, monaco]);
  return monaco;
}
