"use client";

import type * as MonacoNs from "monaco-editor";

import type { Monaco } from "./lazyMonaco";

export type EditorViewState = MonacoNs.editor.ICodeEditorViewState;
export type DiffEditorViewState = MonacoNs.editor.IDiffEditorViewState;

// The lifecycle helpers only use a small slice of the Monaco namespace.
// Narrowing the parameter type to this surface (instead of the full `Monaco`
// type) keeps the helpers easy to fake in tests without resorting to casts.
export type MonacoLifecycleSurface = Pick<Monaco, "Uri"> & {
  editor: Pick<
    Monaco["editor"],
    "getModel" | "createModel" | "setModelLanguage" | "getModels"
  >;
};

const viewStates = new Map<string, EditorViewState>();
const diffViewStates = new Map<string, DiffEditorViewState>();

export function createModel(
  monaco: MonacoLifecycleSurface,
  uri: string,
  content: string,
  language: string,
): MonacoNs.editor.ITextModel {
  const parsed = monaco.Uri.parse(uri);
  const existing = monaco.editor.getModel(parsed);
  if (existing) {
    if (existing.getLanguageId() !== language) {
      monaco.editor.setModelLanguage(existing, language);
    }
    if (existing.getValue() !== content) {
      existing.setValue(content);
    }
    return existing;
  }
  return monaco.editor.createModel(content, language, parsed);
}

export function disposeModel(
  monaco: MonacoLifecycleSurface,
  uri: string,
): boolean {
  const model = monaco.editor.getModel(monaco.Uri.parse(uri));
  if (!model) {
    return false;
  }
  model.dispose();
  return true;
}

export function getViewState(uri: string): EditorViewState | undefined {
  return viewStates.get(uri);
}

export function saveViewState(
  uri: string,
  state: EditorViewState | null,
): void {
  if (state) {
    viewStates.set(uri, state);
  } else {
    viewStates.delete(uri);
  }
}

export interface ViewStateRestorable {
  restoreViewState(state: EditorViewState): void;
}

export interface DiffViewStateRestorable {
  restoreViewState(state: DiffEditorViewState): void;
}

export function restoreViewState(
  editor: ViewStateRestorable,
  uri: string,
): boolean {
  const state = viewStates.get(uri);
  if (!state) {
    return false;
  }
  editor.restoreViewState(state);
  return true;
}

export function getDiffViewState(uri: string): DiffEditorViewState | undefined {
  return diffViewStates.get(uri);
}

export function saveDiffViewState(
  uri: string,
  state: DiffEditorViewState | null,
): void {
  if (state) {
    diffViewStates.set(uri, state);
  } else {
    diffViewStates.delete(uri);
  }
}

export function restoreDiffViewState(
  editor: DiffViewStateRestorable,
  uri: string,
): boolean {
  const state = diffViewStates.get(uri);
  if (!state) {
    return false;
  }
  editor.restoreViewState(state);
  return true;
}

export function clearViewState(uri: string): void {
  viewStates.delete(uri);
  diffViewStates.delete(uri);
}

export function __resetLifecycleForTests(): void {
  viewStates.clear();
  diffViewStates.clear();
}

export function getDisposableBaseline(monaco: MonacoLifecycleSurface): number {
  return monaco.editor.getModels().length;
}
