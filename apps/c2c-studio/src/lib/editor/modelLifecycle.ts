"use client";

import type * as MonacoNs from "monaco-editor";

import type { Monaco } from "./lazyMonaco";

export type EditorViewState = MonacoNs.editor.ICodeEditorViewState;
export type DiffEditorViewState = MonacoNs.editor.IDiffEditorViewState;

const viewStates = new Map<string, EditorViewState>();
const diffViewStates = new Map<string, DiffEditorViewState>();

export function createModel(
  monaco: Monaco,
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

export function disposeModel(monaco: Monaco, uri: string): boolean {
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

export function restoreViewState(
  editor: MonacoNs.editor.ICodeEditor,
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
  editor: MonacoNs.editor.IDiffEditor,
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

export function getDisposableBaseline(monaco: Monaco): number {
  return monaco.editor.getModels().length;
}
