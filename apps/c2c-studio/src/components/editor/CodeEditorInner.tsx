"use client";

import { Editor, DiffEditor, loader } from "@monaco-editor/react";
import type * as MonacoNs from "monaco-editor";
import { useEffect, useMemo, useRef, useState } from "react";

import { getMonaco, type Monaco } from "@/lib/editor/lazyMonaco";
import {
  saveViewState,
  saveDiffViewState,
  restoreViewState,
  restoreDiffViewState,
} from "@/lib/editor/modelLifecycle";
import { applyStudioTheme, STUDIO_DARK_THEME } from "@/lib/editor/monacoTheme";

import { EditorSkeleton } from "./EditorSkeleton";
import {
  applySanitization,
  type CodeEditorProps,
  type DiffCodeEditorProps,
  type EditorMarker,
  type StandaloneCodeEditorProps,
} from "./codeEditorTypes";

export default function CodeEditorInner(props: CodeEditorProps) {
  const [monaco, setMonaco] = useState<Monaco | null>(null);
  const [loadError, setLoadError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;
    getMonaco()
      .then((instance) => {
        if (cancelled) {
          return;
        }
        loader.config({ monaco: instance });
        applyStudioTheme(instance);
        setMonaco(instance);
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        setLoadError(error instanceof Error ? error : new Error(String(error)));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loadError) {
    return (
      <div
        role="alert"
        data-testid="code-editor-error"
        className="flex h-full min-h-0 w-full items-center justify-center bg-bg-0 px-4 text-center text-sm text-error"
      >
        Failed to load editor: {loadError.message}
      </div>
    );
  }

  if (!monaco) {
    return <EditorSkeleton />;
  }

  if (props.mode === "diff") {
    return <DiffEditorView monaco={monaco} {...props} />;
  }
  return <StandaloneEditorView monaco={monaco} {...props} />;
}

interface StandaloneEditorViewProps extends StandaloneCodeEditorProps {
  monaco: Monaco;
}

function StandaloneEditorView({
  monaco,
  mode,
  language,
  value,
  onChange,
  markers,
  actions,
  decorations,
  sanitizationProfile,
  className,
  ariaLabel,
  modelUri,
  viewStateRef,
  onMount,
}: StandaloneEditorViewProps) {
  const editorRef = useRef<MonacoNs.editor.IStandaloneCodeEditor | null>(null);
  const decorationsRef =
    useRef<MonacoNs.editor.IEditorDecorationsCollection | null>(null);
  const resolvedUri = useMemo(
    () => modelUri ?? `inmemory://model/${language}`,
    [modelUri, language],
  );
  const sanitizedValue = useMemo(
    () => applySanitization(value, sanitizationProfile),
    [value, sanitizationProfile],
  );

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) {
      return;
    }
    const model = editor.getModel();
    if (!model) {
      return;
    }
    monaco.editor.setModelMarkers(model, "c2c-studio", markers ?? []);
  }, [monaco, markers]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) {
      return;
    }
    if (decorationsRef.current) {
      decorationsRef.current.clear();
    }
    if (decorations && decorations.length > 0) {
      decorationsRef.current = editor.createDecorationsCollection(decorations);
    } else {
      decorationsRef.current = null;
    }
  }, [decorations]);

  useEffect(() => {
    return () => {
      const editor = editorRef.current;
      if (!editor) {
        return;
      }
      const state = editor.saveViewState();
      saveViewState(resolvedUri, state);
      if (viewStateRef) {
        viewStateRef.current = state;
      }
      if (decorationsRef.current) {
        decorationsRef.current.clear();
        decorationsRef.current = null;
      }
    };
  }, [resolvedUri, viewStateRef]);

  return (
    <div
      data-testid="code-editor-standalone"
      data-mode={mode}
      data-language={language}
      className={className}
      style={{ height: "100%", minHeight: 0, width: "100%" }}
    >
      <Editor
        value={sanitizedValue}
        language={language}
        theme={STUDIO_DARK_THEME}
        loading={<EditorSkeleton />}
        options={{
          readOnly: mode === "readonly",
          minimap: { enabled: true },
          lineNumbers: "on",
          renderWhitespace: "selection",
          smoothScrolling: true,
          automaticLayout: true,
          fontFamily:
            "var(--font-mono), ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
          fontSize: 13,
          ariaLabel: ariaLabel ?? `Code editor (${language})`,
          scrollBeyondLastLine: false,
          fixedOverflowWidgets: true,
        }}
        onMount={(editor, monacoInstance) => {
          editorRef.current = editor;
          const restored = restoreViewState(editor, resolvedUri);
          if (!restored && viewStateRef?.current) {
            editor.restoreViewState(viewStateRef.current);
          }
          const model = editor.getModel();
          if (model) {
            applyMarkers(monacoInstance, model, markers);
          }
          if (decorations && decorations.length > 0) {
            decorationsRef.current =
              editor.createDecorationsCollection(decorations);
          }
          if (actions) {
            for (const action of actions) {
              editor.addAction(action);
            }
          }
          onMount?.({ editor, monaco: monacoInstance as Monaco });
        }}
        onChange={(next) => {
          if (next !== undefined) {
            onChange?.(next);
          }
        }}
      />
    </div>
  );
}

interface DiffEditorViewProps extends DiffCodeEditorProps {
  monaco: Monaco;
}

function DiffEditorView({
  monaco,
  language,
  value,
  original,
  onChange,
  markers,
  actions,
  decorations,
  sanitizationProfile,
  className,
  ariaLabel,
  modelUri,
  onMount,
}: DiffEditorViewProps) {
  const diffEditorRef = useRef<MonacoNs.editor.IStandaloneDiffEditor | null>(
    null,
  );
  const decorationsRef =
    useRef<MonacoNs.editor.IEditorDecorationsCollection | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const resolvedUri = useMemo(
    () => modelUri ?? `inmemory://model/${language}-diff`,
    [modelUri, language],
  );
  const sanitizedModified = useMemo(
    () => applySanitization(value, sanitizationProfile),
    [value, sanitizationProfile],
  );
  const sanitizedOriginal = useMemo(
    () => applySanitization(original, sanitizationProfile),
    [original, sanitizationProfile],
  );

  useEffect(() => {
    const diffEditor = diffEditorRef.current;
    if (!diffEditor) {
      return;
    }
    const modifiedModel = diffEditor.getModifiedEditor().getModel();
    if (modifiedModel) {
      monaco.editor.setModelMarkers(modifiedModel, "c2c-studio", markers ?? []);
    }
  }, [monaco, markers]);

  useEffect(() => {
    const diffEditor = diffEditorRef.current;
    if (!diffEditor) {
      return;
    }
    if (decorationsRef.current) {
      decorationsRef.current.clear();
    }
    if (decorations && decorations.length > 0) {
      decorationsRef.current = diffEditor
        .getModifiedEditor()
        .createDecorationsCollection(decorations);
    } else {
      decorationsRef.current = null;
    }
  }, [decorations]);

  useEffect(() => {
    return () => {
      const diffEditor = diffEditorRef.current;
      if (!diffEditor) {
        return;
      }
      const state = diffEditor.saveViewState();
      saveDiffViewState(resolvedUri, state);
      if (decorationsRef.current) {
        decorationsRef.current.clear();
        decorationsRef.current = null;
      }
    };
  }, [resolvedUri]);

  return (
    <div
      data-testid="code-editor-diff"
      data-mode="diff"
      data-language={language}
      className={className}
      style={{ height: "100%", minHeight: 0, width: "100%" }}
    >
      <DiffEditor
        original={sanitizedOriginal}
        modified={sanitizedModified}
        language={language}
        theme={STUDIO_DARK_THEME}
        loading={<EditorSkeleton />}
        options={{
          readOnly: false,
          renderSideBySide: true,
          minimap: { enabled: true },
          fontFamily:
            "var(--font-mono), ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
          fontSize: 13,
          automaticLayout: true,
          scrollBeyondLastLine: false,
        }}
        onMount={(diffEditor, monacoInstance) => {
          diffEditorRef.current = diffEditor;
          restoreDiffViewState(diffEditor, resolvedUri);
          const modifiedEditor = diffEditor.getModifiedEditor();
          const modifiedModel = modifiedEditor.getModel();
          if (modifiedModel) {
            applyMarkers(monacoInstance, modifiedModel, markers);
            modifiedModel.onDidChangeContent(() => {
              onChangeRef.current?.(modifiedModel.getValue());
            });
          }
          if (decorations && decorations.length > 0) {
            decorationsRef.current =
              modifiedEditor.createDecorationsCollection(decorations);
          }
          if (actions) {
            for (const action of actions) {
              modifiedEditor.addAction(action);
            }
          }
          modifiedEditor.updateOptions({
            ariaLabel: ariaLabel ?? `Diff editor (${language})`,
          });
          onMount?.({ editor: diffEditor, monaco: monacoInstance as Monaco });
        }}
      />
    </div>
  );
}

function applyMarkers(
  monaco: typeof MonacoNs,
  model: MonacoNs.editor.ITextModel,
  markers: EditorMarker[] | undefined,
): void {
  monaco.editor.setModelMarkers(model, "c2c-studio", markers ?? []);
}
