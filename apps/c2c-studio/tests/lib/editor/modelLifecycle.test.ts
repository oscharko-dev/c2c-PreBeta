import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetLifecycleForTests,
  clearViewState,
  createModel,
  disposeModel,
  getDiffViewState,
  getViewState,
  restoreDiffViewState,
  restoreViewState,
  saveDiffViewState,
  saveViewState,
  type DiffEditorViewState,
  type DiffViewStateRestorable,
  type EditorViewState,
  type MonacoLifecycleSurface,
  type ViewStateRestorable,
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

interface MockMonaco extends MonacoLifecycleSurface {
  readonly _models: Map<string, MockModel>;
}

function createMockMonaco(): MockMonaco {
  const models = new Map<string, MockModel>();
  return {
    _models: models,
    // The lifecycle helpers only ever call `.parse(uri).toString()`-equivalent
    // operations on the Uri factory, so a minimal struct satisfies the surface.
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
        const model = makeMockModel({ content, language, uri, models });
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

function makeMockModel(args: {
  content: string;
  language: string;
  uri: { toString: () => string };
  models: Map<string, MockModel>;
}): MockModel {
  const model: MockModel = {
    language: args.language,
    value: args.content,
    uri: args.uri,
    setValue: vi.fn(),
    dispose: vi.fn(),
    getLanguageId: () => model.language,
    getValue: () => model.value,
  };
  model.setValue = vi.fn((next: string) => {
    model.value = next;
  });
  model.dispose = vi.fn(() => {
    args.models.delete(args.uri.toString());
  });
  return model;
}

function makeMockViewStateRestorable(): ViewStateRestorable & {
  restoreViewState: ReturnType<typeof vi.fn>;
} {
  return { restoreViewState: vi.fn() } as ViewStateRestorable & {
    restoreViewState: ReturnType<typeof vi.fn>;
  };
}

function makeMockDiffViewStateRestorable(): DiffViewStateRestorable & {
  restoreViewState: ReturnType<typeof vi.fn>;
} {
  return { restoreViewState: vi.fn() } as DiffViewStateRestorable & {
    restoreViewState: ReturnType<typeof vi.fn>;
  };
}

// Minimal-but-real cast for view-state payloads: tests only need the helpers
// to round-trip an opaque blob, so the value shape is irrelevant.
function stubViewState(payload: Record<string, unknown>): EditorViewState {
  return payload as unknown as EditorViewState;
}

function stubDiffViewState(
  payload: Record<string, unknown>,
): DiffEditorViewState {
  return payload as unknown as DiffEditorViewState;
}

describe("modelLifecycle", () => {
  beforeEach(() => {
    __resetLifecycleForTests();
  });

  it("createModel returns the existing model when one already exists for the URI", () => {
    const monaco = createMockMonaco();
    const first = createModel(monaco, "inmemory://a", "one", "java");
    const second = createModel(monaco, "inmemory://a", "two", "java");
    expect(second).toBe(first);
    expect((second as unknown as MockModel).getValue()).toBe("two");
  });

  it("createModel changes the language when the URI is reused with a different language", () => {
    const monaco = createMockMonaco();
    const m = createModel(monaco, "inmemory://lang", "x", "json");
    createModel(monaco, "inmemory://lang", "x", "xml");
    expect((m as unknown as MockModel).getLanguageId()).toBe("xml");
  });

  it("disposeModel disposes an existing model and returns false when there is nothing to dispose", () => {
    const monaco = createMockMonaco();
    createModel(monaco, "inmemory://b", "one", "json");
    expect(disposeModel(monaco, "inmemory://b")).toBe(true);
    expect(disposeModel(monaco, "inmemory://b")).toBe(false);
  });

  it("returns to baseline disposable count after 50 mount/unmount cycles", () => {
    const monaco = createMockMonaco();
    const baseline = monaco.editor.getModels().length;
    for (let i = 0; i < 50; i += 1) {
      const uri = `inmemory://cycle-${i}`;
      createModel(monaco, uri, `content-${i}`, "java");
      expect(disposeModel(monaco, uri)).toBe(true);
    }
    const remaining = monaco.editor.getModels().length;
    expect(Math.abs(remaining - baseline)).toBeLessThanOrEqual(1);
    expect(remaining).toBe(baseline);
  });

  it("view-state round-trip restores the same object", () => {
    const state = stubViewState({
      scroll: 42,
      cursor: { lineNumber: 3, column: 5 },
    });
    saveViewState("inmemory://r", state);
    expect(getViewState("inmemory://r")).toEqual(state);
  });

  it("saveViewState with null clears the stored state", () => {
    saveViewState("inmemory://r", stubViewState({ cursor: 1 }));
    saveViewState("inmemory://r", null);
    expect(getViewState("inmemory://r")).toBeUndefined();
  });

  it("restoreViewState applies the stored state to the given editor", () => {
    const state = stubViewState({ scroll: 1 });
    saveViewState("inmemory://e", state);
    const editor = makeMockViewStateRestorable();
    const ok = restoreViewState(editor, "inmemory://e");
    expect(ok).toBe(true);
    expect(editor.restoreViewState).toHaveBeenCalledWith(state);
  });

  it("restoreViewState returns false when no state is stored", () => {
    const editor = makeMockViewStateRestorable();
    const ok = restoreViewState(editor, "inmemory://missing");
    expect(ok).toBe(false);
    expect(editor.restoreViewState).not.toHaveBeenCalled();
  });

  it("clearViewState removes both standalone and diff state", () => {
    saveViewState("inmemory://c", stubViewState({ a: 1 }));
    saveDiffViewState("inmemory://c", stubDiffViewState({ b: 2 }));
    clearViewState("inmemory://c");
    expect(getViewState("inmemory://c")).toBeUndefined();
    expect(getDiffViewState("inmemory://c")).toBeUndefined();
  });

  it("diff view-state round-trip restores the same object", () => {
    const state = stubDiffViewState({
      modified: { scrollTop: 10 },
      original: { scrollTop: 4 },
    });
    saveDiffViewState("inmemory://diff", state);
    const editor = makeMockDiffViewStateRestorable();
    const ok = restoreDiffViewState(editor, "inmemory://diff");
    expect(ok).toBe(true);
    expect(editor.restoreViewState).toHaveBeenCalledWith(state);
  });

  it("restoreDiffViewState returns false when no diff state is stored", () => {
    const editor = makeMockDiffViewStateRestorable();
    const ok = restoreDiffViewState(editor, "inmemory://missing-diff");
    expect(ok).toBe(false);
    expect(editor.restoreViewState).not.toHaveBeenCalled();
  });
});
