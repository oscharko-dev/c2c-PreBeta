import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetLifecycleForTests,
  createModel,
  disposeModel,
  getDiffViewState,
  getViewState,
  saveDiffViewState,
  saveViewState,
  type DiffEditorViewState,
  type EditorViewState,
  type MonacoLifecycleSurface,
} from "@/lib/editor/modelLifecycle";

interface MockModel {
  language: string;
  uri: { toString: () => string };
  dispose: ReturnType<typeof vi.fn>;
  getLanguageId: () => string;
  getValue: () => string;
  setValue: (next: string) => void;
}

function createMockMonaco(): MonacoLifecycleSurface {
  const models = new Map<string, MockModel>();
  return {
    Uri: {
      parse: (s: string) => ({ toString: () => s }),
    } as unknown as MonacoLifecycleSurface["Uri"],
    editor: {
      getModel: ((uri: { toString: () => string }) =>
        models.get(uri.toString()) ??
        null) as unknown as MonacoLifecycleSurface["editor"]["getModel"],
      createModel: ((
        content: string,
        language: string,
        uri: { toString: () => string },
      ) => {
        let currentValue = content;
        const model: MockModel = {
          language,
          uri,
          dispose: vi.fn(() => {
            models.delete(uri.toString());
          }),
          getLanguageId: () => model.language,
          getValue: () => currentValue,
          setValue: (next: string) => {
            currentValue = next;
          },
        };
        models.set(uri.toString(), model);
        return model;
      }) as unknown as MonacoLifecycleSurface["editor"]["createModel"],
      setModelLanguage: ((model: MockModel, language: string) => {
        model.language = language;
      }) as unknown as MonacoLifecycleSurface["editor"]["setModelLanguage"],
      getModels: (() =>
        Array.from(
          models.values(),
        )) as unknown as MonacoLifecycleSurface["editor"]["getModels"],
    },
  };
}

describe("disposeModel <-> view-state lifecycle symmetry (#258 Copilot review)", () => {
  beforeEach(() => {
    __resetLifecycleForTests();
  });

  it("clears the standalone view-state entry for the URI when the model is disposed", () => {
    const monaco = createMockMonaco();
    createModel(monaco, "inmemory://leak-check", "x", "java");
    saveViewState("inmemory://leak-check", {
      scroll: 1,
    } as unknown as EditorViewState);
    expect(getViewState("inmemory://leak-check")).toBeDefined();

    expect(disposeModel(monaco, "inmemory://leak-check")).toBe(true);

    expect(getViewState("inmemory://leak-check")).toBeUndefined();
  });

  it("clears the diff view-state entry for the URI when the model is disposed", () => {
    const monaco = createMockMonaco();
    createModel(monaco, "inmemory://diff-leak", "x", "java");
    saveDiffViewState("inmemory://diff-leak", {
      scroll: 2,
    } as unknown as DiffEditorViewState);
    expect(getDiffViewState("inmemory://diff-leak")).toBeDefined();

    expect(disposeModel(monaco, "inmemory://diff-leak")).toBe(true);

    expect(getDiffViewState("inmemory://diff-leak")).toBeUndefined();
  });

  it("clears view state even when no model exists for the URI", () => {
    const monaco = createMockMonaco();
    saveViewState("inmemory://stale", {
      scroll: 9,
    } as unknown as EditorViewState);
    saveDiffViewState("inmemory://stale", {
      scroll: 9,
    } as unknown as DiffEditorViewState);

    // No model registered for this URI, but the caller still expects the
    // bookkeeping to be cleaned up so the Maps don't grow without bound.
    expect(disposeModel(monaco, "inmemory://stale")).toBe(false);

    expect(getViewState("inmemory://stale")).toBeUndefined();
    expect(getDiffViewState("inmemory://stale")).toBeUndefined();
  });

  it("does not affect view state stored under different URIs", () => {
    const monaco = createMockMonaco();
    createModel(monaco, "inmemory://keep", "x", "java");
    saveViewState("inmemory://keep", {
      scroll: 7,
    } as unknown as EditorViewState);
    createModel(monaco, "inmemory://drop", "x", "java");
    saveViewState("inmemory://drop", {
      scroll: 11,
    } as unknown as EditorViewState);

    disposeModel(monaco, "inmemory://drop");

    expect(getViewState("inmemory://drop")).toBeUndefined();
    expect(getViewState("inmemory://keep")).toBeDefined();
  });
});
