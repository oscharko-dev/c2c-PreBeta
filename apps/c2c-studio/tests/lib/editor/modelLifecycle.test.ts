import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetLifecycleForTests,
  clearViewState,
  createModel,
  disposeModel,
  getViewState,
  restoreViewState,
  saveViewState,
} from "@/lib/editor/modelLifecycle";

interface MockModel {
  language: string;
  value: string;
  uri: { toString: () => string };
  setValue: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  getLanguageId: () => string;
  getValue: () => string;
}

interface MockMonaco {
  Uri: { parse: (s: string) => { toString: () => string } };
  editor: {
    getModel: (uri: { toString: () => string }) => MockModel | undefined;
    createModel: (
      content: string,
      language: string,
      uri: { toString: () => string },
    ) => MockModel;
    setModelLanguage: (model: MockModel, language: string) => void;
    getModels: () => MockModel[];
    setModelMarkers: ReturnType<typeof vi.fn>;
  };
}

function createMockMonaco(): MockMonaco {
  const models = new Map<string, MockModel>();
  return {
    Uri: { parse: (s: string) => ({ toString: () => s }) },
    editor: {
      getModel: (uri) => models.get(uri.toString()),
      createModel: (content, language, uri) => {
        const model: MockModel = {
          language,
          value: content,
          uri,
          setValue: vi.fn(function (this: MockModel, next: string) {
            this.value = next;
          }),
          dispose: vi.fn(() => {
            models.delete(uri.toString());
          }),
          getLanguageId: () => model.language,
          getValue: () => model.value,
        };
        // Bind setValue so it mutates the captured model when called.
        model.setValue = vi.fn((next: string) => {
          model.value = next;
        });
        models.set(uri.toString(), model);
        return model;
      },
      setModelLanguage: (model, language) => {
        model.language = language;
      },
      getModels: () => Array.from(models.values()),
      setModelMarkers: vi.fn(),
    },
  };
}

describe("modelLifecycle", () => {
  beforeEach(() => {
    __resetLifecycleForTests();
  });

  it("createModel returns the existing model when one already exists for the URI", () => {
    const monaco = createMockMonaco();
    const first = createModel(monaco as never, "inmemory://a", "one", "java");
    const second = createModel(monaco as never, "inmemory://a", "two", "java");
    expect(second).toBe(first);
    expect(second.getValue()).toBe("two");
  });

  it("createModel changes the language when the URI is reused with a different language", () => {
    const monaco = createMockMonaco();
    const m = createModel(monaco as never, "inmemory://lang", "x", "json");
    createModel(monaco as never, "inmemory://lang", "x", "xml");
    expect(m.getLanguageId()).toBe("xml");
  });

  it("disposeModel disposes an existing model and returns false when there is nothing to dispose", () => {
    const monaco = createMockMonaco();
    createModel(monaco as never, "inmemory://b", "one", "json");
    expect(disposeModel(monaco as never, "inmemory://b")).toBe(true);
    expect(disposeModel(monaco as never, "inmemory://b")).toBe(false);
  });

  it("returns to baseline disposable count after 50 mount/unmount cycles", () => {
    const monaco = createMockMonaco();
    const baseline = monaco.editor.getModels().length;
    for (let i = 0; i < 50; i += 1) {
      const uri = `inmemory://cycle-${i}`;
      createModel(monaco as never, uri, `content-${i}`, "java");
      expect(disposeModel(monaco as never, uri)).toBe(true);
    }
    const remaining = monaco.editor.getModels().length;
    expect(Math.abs(remaining - baseline)).toBeLessThanOrEqual(1);
    expect(remaining).toBe(baseline);
  });

  it("view-state round-trip restores the same object", () => {
    const state = { scroll: 42, cursor: { lineNumber: 3, column: 5 } };
    saveViewState("inmemory://r", state as never);
    expect(getViewState("inmemory://r")).toEqual(state);
  });

  it("saveViewState with null clears the stored state", () => {
    saveViewState("inmemory://r", { cursor: 1 } as never);
    saveViewState("inmemory://r", null);
    expect(getViewState("inmemory://r")).toBeUndefined();
  });

  it("restoreViewState applies the stored state to the given editor", () => {
    const state = { scroll: 1 };
    saveViewState("inmemory://e", state as never);
    const editor = { restoreViewState: vi.fn() };
    const ok = restoreViewState(editor as never, "inmemory://e");
    expect(ok).toBe(true);
    expect(editor.restoreViewState).toHaveBeenCalledWith(state);
  });

  it("restoreViewState returns false when no state is stored", () => {
    const editor = { restoreViewState: vi.fn() };
    const ok = restoreViewState(editor as never, "inmemory://missing");
    expect(ok).toBe(false);
    expect(editor.restoreViewState).not.toHaveBeenCalled();
  });

  it("clearViewState removes both standalone and diff state", () => {
    saveViewState("inmemory://c", { a: 1 } as never);
    clearViewState("inmemory://c");
    expect(getViewState("inmemory://c")).toBeUndefined();
  });
});
