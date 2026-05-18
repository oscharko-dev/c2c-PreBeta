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

import { EditorSkeleton } from "@/components/editor/EditorSkeleton";
import {
  applySanitization,
  type CodeEditorProps,
  type DiffCodeEditorProps,
  type EditorDecoration,
  type EditorMarker,
  type EditorMarkerGroup,
  type StandaloneCodeEditorProps,
} from "@/components/editor/codeEditorTypes";

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
  markerGroups,
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
  // Disposable for the standalone editor's `onDidChangeModel` subscription.
  // We re-apply markers (read from `markersRef` to avoid stale closures) when
  // @monaco-editor/react swaps in a new model because `path` changed.
  const modelChangeDisposableRef = useRef<MonacoNs.IDisposable | null>(null);
  // Latest markers / decorations — read from these refs inside the
  // `onDidChangeModel` callback so it does not capture stale values from
  // the onMount-time closure. Without this, prop changes after mount would
  // be ignored on every subsequent model swap.
  const markersRef = useRef<EditorMarker[] | undefined>(markers);
  markersRef.current = markers;
  const markerGroupsRef = useRef<EditorMarkerGroup[] | undefined>(markerGroups);
  markerGroupsRef.current = markerGroups;
  // Tracks the owner labels that wrote markers in the last render so
  // an owner that disappears between renders is cleared (set to []).
  const previousOwnersRef = useRef<Set<string>>(new Set());
  const decorationsPropRef = useRef<EditorDecoration[] | undefined>(
    decorations,
  );
  decorationsPropRef.current = decorations;
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
  // The onMount-time `onDidChangeModel` handler must restore view state for
  // the *current* URI (not the URI captured when the handler was registered),
  // so the lookup goes through this ref.
  const resolvedUriRef = useRef(resolvedUri);
  resolvedUriRef.current = resolvedUri;
  const sanitizedValue = useMemo(
    () => applySanitization(value, sanitizationProfile),
    [value, sanitizationProfile],
  );
  // Latest "expected" value, used to detect prop-driven changes that
  // @monaco-editor/react applies via `executeEdits` (which emits non-flush
  // content events that the `event.isFlush` guard alone would let through).
  const sanitizedValueRef = useRef(sanitizedValue);
  sanitizedValueRef.current = sanitizedValue;

  // Re-apply markers whenever the markers/markerGroups props change. The
  // handler reads `editor.getModel()` at call time so it targets the
  // current (post-swap) model. The owner-tracking guarantees that a
  // marker group that disappears between renders gets its owner cleared.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) {
      return;
    }
    const model = editor.getModel();
    if (!model) {
      return;
    }
    applyMarkers(
      monaco,
      model,
      markers,
      markerGroups,
      previousOwnersRef.current,
    );
  }, [monaco, markers, markerGroups]);

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

  // Persist view state per-URI whenever `resolvedUri` is about to change
  // (cleanup captures the old value via closure) and on unmount.
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
    };
  }, [resolvedUri, viewStateRef]);

  // Dispose long-lived editor resources only on actual unmount. The previous
  // single-effect approach disposed listeners every time `resolvedUri`
  // changed, which would silently break model-swap re-wiring while the
  // editor was still mounted.
  useEffect(() => {
    return () => {
      if (modelChangeDisposableRef.current) {
        modelChangeDisposableRef.current.dispose();
        modelChangeDisposableRef.current = null;
      }
      if (decorationsRef.current) {
        decorationsRef.current.clear();
        decorationsRef.current = null;
      }
    };
  }, []);

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
          // Studio-IDE-12 (#250) §Performance test seam: expose the
          // most-recently-mounted Monaco editor as a global so the
          // perf harness can call ``editor.trigger(...)`` /
          // ``editor.focus()`` without needing a Studio-internal
          // ref. Gated on
          // ``NEXT_PUBLIC_C2C_PERF_HARNESS === "1"`` so production
          // bundles never expose the global.
          if (
            typeof window !== "undefined" &&
            process.env.NEXT_PUBLIC_C2C_PERF_HARNESS === "1"
          ) {
            (
              window as unknown as {
                __c2cMonacoEditor?: import("monaco-editor").editor.IStandaloneCodeEditor;
              }
            ).__c2cMonacoEditor = editor;
          }
          const restored = restoreViewState(editor, resolvedUri);
          if (!restored && viewStateRef?.current) {
            editor.restoreViewState(viewStateRef.current);
          }
          const model = editor.getModel();
          if (model) {
            applyMarkers(
              monacoInstance,
              model,
              markers,
              markerGroups,
              previousOwnersRef.current,
            );
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
          // When the path prop changes, @monaco-editor/react swaps the
          // underlying Monaco model. The current markers / decorations
          // were attached to the previous model and the saved view state
          // for the new URI has never been applied — restore everything
          // on every swap so a long-lived editor that hops between URIs
          // stays consistent with its view-state map.
          modelChangeDisposableRef.current = editor.onDidChangeModel(() => {
            const newModel = editor.getModel();
            if (!newModel) {
              return;
            }
            applyMarkers(
              monacoInstance,
              newModel,
              markersRef.current,
              markerGroupsRef.current,
              previousOwnersRef.current,
            );
            restoreViewState(editor, resolvedUriRef.current);
            if (decorationsRef.current) {
              decorationsRef.current.clear();
              decorationsRef.current = null;
            }
            const currentDecorations = decorationsPropRef.current;
            if (currentDecorations && currentDecorations.length > 0) {
              decorationsRef.current =
                editor.createDecorationsCollection(currentDecorations);
            }
          });
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
          // when `@monaco-editor/react` applies a new `value` prop via
          // `setValue`, not when the user edits.
          if (event?.isFlush) {
            return;
          }
          // Newer @monaco-editor/react versions apply value-prop refreshes
          // via `executeEdits` instead of `setValue`, which emits non-flush
          // content events. Compare against the latest sanitized prop and
          // skip when they match — that change just brought the model in
          // line with the prop we already gave it.
          if (next === sanitizedValueRef.current) {
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
  markerGroups,
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
  // Latest markers / decorations — read inside the model-swap callback so
  // we don't apply stale values captured at onMount time. Prop changes
  // after mount must still apply on every subsequent swap.
  const markersRef = useRef<EditorMarker[] | undefined>(markers);
  markersRef.current = markers;
  const markerGroupsRef = useRef<EditorMarkerGroup[] | undefined>(markerGroups);
  markerGroupsRef.current = markerGroups;
  const previousOwnersRef = useRef<Set<string>>(new Set());
  const decorationsPropRef = useRef<EditorDecoration[] | undefined>(
    decorations,
  );
  decorationsPropRef.current = decorations;
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
  // The diff `onDidChangeModel` callback restores view state for the
  // *current* URI; this ref carries that value across swaps.
  const resolvedUriRef = useRef(resolvedUri);
  resolvedUriRef.current = resolvedUri;
  const sanitizedModified = useMemo(
    () => applySanitization(value, sanitizationProfile),
    [value, sanitizationProfile],
  );
  const sanitizedOriginal = useMemo(
    () => applySanitization(original, sanitizationProfile),
    [original, sanitizationProfile],
  );
  // Latest "expected" model contents. The content-change listener compares
  // the post-change model value against this; when they match, the change
  // is just @monaco-editor/react replaying the `modified` prop (which 4.7
  // does via `executeEdits` → `isFlush === false`, slipping past the
  // earlier `event.isFlush` guard).
  const sanitizedModifiedRef = useRef(sanitizedModified);
  sanitizedModifiedRef.current = sanitizedModified;

  // Re-apply markers when the markers prop changes. The handler reads
  // `diffEditor.getModifiedEditor().getModel()` at call time so it always
  // targets the current (post-swap) modified model.
  useEffect(() => {
    const diffEditor = diffEditorRef.current;
    if (!diffEditor) {
      return;
    }
    const modifiedModel = diffEditor.getModifiedEditor().getModel();
    if (modifiedModel) {
      applyMarkers(
        monaco,
        modifiedModel,
        markers,
        markerGroups,
        previousOwnersRef.current,
      );
    }
  }, [monaco, markers, markerGroups]);

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

  // Persist diff view state per-URI on URI change (cleanup captures the old
  // value via closure) and on unmount.
  useEffect(() => {
    return () => {
      const diffEditor = diffEditorRef.current;
      if (!diffEditor) {
        return;
      }
      const state = diffEditor.saveViewState();
      saveDiffViewState(resolvedUri, state);
    };
  }, [resolvedUri]);

  // Dispose long-lived listeners only on actual unmount. Tying this to
  // `resolvedUri` (as the original effect did) would tear down the
  // content-listener wiring and the onDidChangeModel hook every time the
  // URI changed, leaving subsequent model swaps unwired.
  useEffect(() => {
    return () => {
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
  }, []);

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

          // Wire (or re-wire) all model-scoped state to whatever model the
          // modified editor currently holds. Called once at mount and again
          // any time @monaco-editor/react swaps in a new model (e.g. when
          // `modifiedModelPath` changes while the editor stays mounted).
          // All prop-dependent values are read through refs so updates
          // after mount are applied on every swap.
          const rewireModifiedModel = (): void => {
            if (contentChangeDisposableRef.current) {
              contentChangeDisposableRef.current.dispose();
              contentChangeDisposableRef.current = null;
            }
            const currentModel = modifiedEditor.getModel();
            if (!currentModel) {
              return;
            }
            applyMarkers(
              monacoInstance,
              currentModel,
              markersRef.current,
              markerGroupsRef.current,
              previousOwnersRef.current,
            );
            // The new URI may already have saved view state; restore it now
            // since the onMount-time restore only fires on initial mount.
            restoreDiffViewState(diffEditor, resolvedUriRef.current);
            // The previous decorations collection was bound to the old
            // model; recreate from the current prop on every swap so
            // long-lived editors that switch URIs keep their highlights.
            if (decorationsRef.current) {
              decorationsRef.current.clear();
              decorationsRef.current = null;
            }
            const currentDecorations = decorationsPropRef.current;
            if (currentDecorations && currentDecorations.length > 0) {
              decorationsRef.current =
                modifiedEditor.createDecorationsCollection(currentDecorations);
            }
            contentChangeDisposableRef.current =
              currentModel.onDidChangeContent((event) => {
                // Suppress whole-model replacements — those are emitted when
                // @monaco-editor/react flushes a new `modified` prop via
                // `setValue`.
                if (event.isFlush) {
                  return;
                }
                // @monaco-editor/react 4.7 applies updates to the writable
                // diff side via `executeEdits` instead of `setValue`, which
                // emits non-flush content events. Compare the post-change
                // model value against the latest `modified` prop and skip
                // when they match — that is, when the change just brought
                // the model in line with the prop we already gave Monaco.
                const next = currentModel.getValue();
                if (next === sanitizedModifiedRef.current) {
                  return;
                }
                onChangeRef.current?.(next);
              });
          };

          rewireModifiedModel();
          // Re-run the wiring whenever the underlying model is swapped so a
          // long-lived diff editor that changes URIs keeps emitting
          // onChange for user edits in the new pane and stays in sync with
          // its view state, markers, and decorations.
          modelChangeDisposableRef.current =
            modifiedEditor.onDidChangeModel(rewireModifiedModel);
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

// Studio-IDE-5 (#244): per-owner marker application. The legacy
// `markers` prop continues to write into the "c2c-studio" owner so
// existing callers keep working; new callers should pass
// `markerGroups` to scope markers per sourceKind. Owners that wrote
// markers in a previous render but are absent in the next render get
// cleared explicitly so disappearing diagnostics never leave stale
// markers on the editor.
function applyMarkers(
  monaco: typeof MonacoNs,
  model: MonacoNs.editor.ITextModel,
  markers: EditorMarker[] | undefined,
  markerGroups: EditorMarkerGroup[] | undefined,
  previousOwners: Set<string>,
): void {
  const nextOwners = new Set<string>();
  // Legacy single-owner channel.
  if (markers !== undefined) {
    monaco.editor.setModelMarkers(model, "c2c-studio", markers);
    nextOwners.add("c2c-studio");
  } else if (previousOwners.has("c2c-studio")) {
    monaco.editor.setModelMarkers(model, "c2c-studio", []);
  }
  for (const group of markerGroups ?? []) {
    monaco.editor.setModelMarkers(model, group.owner, group.markers);
    nextOwners.add(group.owner);
  }
  for (const owner of previousOwners) {
    if (!nextOwners.has(owner)) {
      monaco.editor.setModelMarkers(model, owner, []);
    }
  }
  previousOwners.clear();
  for (const owner of nextOwners) {
    previousOwners.add(owner);
  }
}
