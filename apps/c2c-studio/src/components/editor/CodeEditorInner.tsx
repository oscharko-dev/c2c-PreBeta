"use client";

import { Editor, DiffEditor, loader } from "@monaco-editor/react";
import type * as MonacoNs from "monaco-editor";
import { useEffect, useId, useMemo, useRef, useState } from "react";

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
  // useId() gives each <CodeEditor> instance a stable, unique fallback URI
  // so two editors with the same language but no explicit `modelUri` do not
  // accidentally share a Monaco model (which would cause one editor's edits
  // / undo history to bleed into the other when @monaco-editor/react
  // resolves the same `path` to the same model). Callers that *want* model
  // sharing must pass an explicit `modelUri`.
  const fallbackUriId = useId();
  const resolvedUri = useMemo(
    () => modelUri ?? `inmemory://model/${language}/${fallbackUriId}`,
    [modelUri, language, fallbackUriId],
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
        // Pass the resolved URI so @monaco-editor/react creates (and reuses)
        // a model keyed by it. Without `path`, every mount creates an anonymous
        // model and URI-scoped diagnostics, language-service state, undo
        // history, etc. won't line up with the lifecycle helpers' `modelUri`.
        path={resolvedUri}
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
          onMount?.({ editor, monaco: monacoInstance });
        }}
        onChange={(next, event) => {
          // Suppress all change events in readonly mode — the user cannot type,
          // so every emission is from a programmatic `setValue` and would
          // otherwise mark consumers' buffers dirty for refreshes.
          if (mode === "readonly") {
            return;
          }
          // Suppress whole-model replacements (isFlush) — those are emitted
          // when `@monaco-editor/react` applies a new `value` prop, not when
          // the user edits.
          if (event?.isFlush) {
            return;
          }
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
  originalModelUri,
  onMount,
}: DiffEditorViewProps) {
  const diffEditorRef = useRef<MonacoNs.editor.IStandaloneDiffEditor | null>(
    null,
  );
  const decorationsRef =
    useRef<MonacoNs.editor.IEditorDecorationsCollection | null>(null);
  const contentChangeDisposableRef = useRef<MonacoNs.IDisposable | null>(null);
  // Disposable for the modified editor's `onDidChangeModel` subscription.
  // When @monaco-editor/react swaps the modified model (e.g., because
  // `modifiedModelPath` changed), we need to rewire the content listener
  // to the new model — otherwise edits in the new pane would silently stop
  // calling `onChange`.
  const modelChangeDisposableRef = useRef<MonacoNs.IDisposable | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  // Per-instance unique IDs for the fallback URIs so multiple diff editors
  // with the same language but no explicit `modelUri` do not share Monaco
  // models. Callers that *want* model sharing must pass `modelUri` (and
  // optionally `originalModelUri`) explicitly.
  const fallbackUriId = useId();
  const resolvedUri = useMemo(
    () => modelUri ?? `inmemory://model/${language}-diff/${fallbackUriId}`,
    [modelUri, language, fallbackUriId],
  );
  const resolvedOriginalUri = useMemo(
    () => originalModelUri ?? `${resolvedUri}~original`,
    [originalModelUri, resolvedUri],
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
      if (modelChangeDisposableRef.current) {
        modelChangeDisposableRef.current.dispose();
        modelChangeDisposableRef.current = null;
      }
      if (contentChangeDisposableRef.current) {
        contentChangeDisposableRef.current.dispose();
        contentChangeDisposableRef.current = null;
      }
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
        // Pass URIs for both sides so the underlying Monaco models are scoped
        // by URI, just like the standalone editor's `path`. Without these,
        // Monaco creates anonymous models and any URI-scoped consumer state
        // (e.g., diagnostics, language services) will not line up.
        originalModelPath={resolvedOriginalUri}
        modifiedModelPath={resolvedUri}
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

          // Wire (or re-wire) a content listener to whatever model the
          // modified editor currently holds. Called once at mount and again
          // any time @monaco-editor/react swaps in a new model (e.g. when
          // `modifiedModelPath` changes while the editor stays mounted).
          const rewireContentListener = (): void => {
            if (contentChangeDisposableRef.current) {
              contentChangeDisposableRef.current.dispose();
              contentChangeDisposableRef.current = null;
            }
            const currentModel = modifiedEditor.getModel();
            if (!currentModel) {
              return;
            }
            applyMarkers(monacoInstance, currentModel, markers);
            contentChangeDisposableRef.current =
              currentModel.onDidChangeContent((event) => {
                // Suppress whole-model replacements — those are emitted when
                // @monaco-editor/react flushes a new `modified` prop, not
                // when the user edits.
                if (event.isFlush) {
                  return;
                }
                onChangeRef.current?.(currentModel.getValue());
              });
          };

          rewireContentListener();
          // Re-run the wiring whenever the underlying model is swapped so a
          // long-lived diff editor that changes URIs keeps emitting
          // onChange for user edits in the new pane.
          modelChangeDisposableRef.current = modifiedEditor.onDidChangeModel(
            rewireContentListener,
          );

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
          onMount?.({ editor: diffEditor, monaco: monacoInstance });
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
