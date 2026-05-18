import type * as MonacoNs from "monaco-editor";

import type { Monaco } from "@/lib/editor/lazyMonaco";

export type CodeEditorMode = "editable" | "readonly" | "diff";

export type SanitizationProfile =
  | "none"
  | "strip-trailing-whitespace"
  | "normalize-newlines";

export type EditorMarker = MonacoNs.editor.IMarkerData;

export type EditorDecoration = MonacoNs.editor.IModelDeltaDecoration;

export type EditorAction = MonacoNs.editor.IActionDescriptor;

export interface CodeEditorViewStateRef {
  current: MonacoNs.editor.ICodeEditorViewState | null;
}

export interface DiffEditorMountArgs {
  editor: MonacoNs.editor.IStandaloneDiffEditor;
  monaco: Monaco;
}

export interface StandaloneEditorMountArgs {
  editor: MonacoNs.editor.IStandaloneCodeEditor;
  monaco: Monaco;
}

interface CodeEditorBaseProps {
  language: string;
  markers?: EditorMarker[];
  actions?: EditorAction[];
  decorations?: EditorDecoration[];
  sanitizationProfile?: SanitizationProfile;
  className?: string;
  ariaLabel?: string;
  /**
   * Stable identifier used to scope view-state preservation across mount/unmount.
   * Defaults to `inmemory://model/<language>` if omitted.
   */
  modelUri?: string;
}

export interface StandaloneCodeEditorProps extends CodeEditorBaseProps {
  mode: "editable" | "readonly";
  value: string;
  onChange?: (value: string) => void;
  viewStateRef?: CodeEditorViewStateRef;
  onMount?: (args: StandaloneEditorMountArgs) => void;
}

export interface DiffCodeEditorProps extends CodeEditorBaseProps {
  mode: "diff";
  value: string;
  original: string;
  /**
   * Stable identifier for the *original* (left-hand) model in a diff view.
   * The `modelUri` prop is used for the modified (right-hand) model. When
   * `originalModelUri` is omitted, it defaults to the effective `modelUri`
   * with a `~original` suffix appended, so the two diff sides never share
   * the same underlying Monaco model.
   */
  originalModelUri?: string;
  onChange?: (value: string) => void;
  onMount?: (args: DiffEditorMountArgs) => void;
}

export type CodeEditorProps = StandaloneCodeEditorProps | DiffCodeEditorProps;

export function applySanitization(
  value: string,
  profile: SanitizationProfile | undefined,
): string {
  switch (profile) {
    case "strip-trailing-whitespace":
      return value.replace(/[ \t]+$/gm, "");
    case "normalize-newlines":
      return value.replace(/\r\n?/g, "\n");
    case "none":
    case undefined:
      return value;
  }
}
