"use client";

import dynamic from "next/dynamic";

import { EditorSkeleton } from "./EditorSkeleton";
import type { CodeEditorProps } from "./codeEditorTypes";

const CodeEditorInner = dynamic(() => import("./CodeEditorInner"), {
  ssr: false,
  loading: () => <EditorSkeleton />,
});

export function CodeEditor(props: CodeEditorProps) {
  return <CodeEditorInner {...props} />;
}

export type {
  CodeEditorProps,
  CodeEditorMode,
  SanitizationProfile,
  EditorMarker,
  EditorDecoration,
  EditorAction,
  CodeEditorViewStateRef,
  StandaloneCodeEditorProps,
  DiffCodeEditorProps,
  StandaloneEditorMountArgs,
  DiffEditorMountArgs,
} from "./codeEditorTypes";
