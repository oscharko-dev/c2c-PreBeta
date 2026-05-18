"use client";

import type { Monaco } from "./lazyMonaco";

export const STUDIO_DARK_THEME = "c2c-studio-dark";

// Color values mirror tokens declared in apps/c2c-studio/src/app/globals.css.
// Keep this table in sync with that file — Monaco's IStandaloneThemeData
// requires concrete hex colors and does not resolve CSS custom properties.
const studioPalette = {
  bg0: "#0b0d10",
  bg1: "#101216",
  bg2: "#14171c",
  bg3: "#1a1e25",
  lineDefault: "#23272f",
  line2: "#2c313b",
  line3: "#393f4b",
  text: "#d6d9e0",
  textDim: "#8a90a0",
  textFaint: "#747b8c",
  textBright: "#eef0f4",
  accent: "#4eba87",
  accentSoft: "#1f2c25",
  warn: "#d4a25b",
  error: "#d96168",
  teal: "#4eba87",
  violet: "#b58af0",
  orange: "#e08e58",
} as const;

let themeDefined = false;

export function applyStudioTheme(monaco: Monaco): void {
  if (!themeDefined) {
    monaco.editor.defineTheme(STUDIO_DARK_THEME, buildThemeData());
    themeDefined = true;
  }
  monaco.editor.setTheme(STUDIO_DARK_THEME);
}

export function __resetThemeForTests(): void {
  themeDefined = false;
}

function buildThemeData(): Parameters<Monaco["editor"]["defineTheme"]>[1] {
  // Inherit from vs-dark so any token we do not override falls back to a sensible default.
  return {
    base: "vs-dark",
    inherit: true,
    rules: [
      {
        token: "",
        foreground: stripHash(studioPalette.text),
        background: stripHash(studioPalette.bg0),
      },
      {
        token: "comment",
        foreground: stripHash(studioPalette.textFaint),
        fontStyle: "italic",
      },
      { token: "keyword", foreground: stripHash(studioPalette.violet) },
      { token: "string", foreground: stripHash(studioPalette.accent) },
      { token: "number", foreground: stripHash(studioPalette.orange) },
      { token: "type", foreground: stripHash(studioPalette.teal) },
      { token: "identifier", foreground: stripHash(studioPalette.text) },
      { token: "delimiter", foreground: stripHash(studioPalette.textDim) },
      { token: "tag", foreground: stripHash(studioPalette.violet) },
      { token: "attribute.name", foreground: stripHash(studioPalette.teal) },
      { token: "attribute.value", foreground: stripHash(studioPalette.accent) },
      { token: "invalid", foreground: stripHash(studioPalette.error) },
    ],
    colors: {
      "editor.background": studioPalette.bg0,
      "editor.foreground": studioPalette.text,
      "editorLineNumber.foreground": studioPalette.textFaint,
      "editorLineNumber.activeForeground": studioPalette.text,
      "editor.lineHighlightBackground": studioPalette.bg1,
      "editor.lineHighlightBorder": studioPalette.bg1,
      "editor.selectionBackground": studioPalette.accentSoft,
      "editor.inactiveSelectionBackground": studioPalette.bg2,
      "editorCursor.foreground": studioPalette.accent,
      "editorWhitespace.foreground": studioPalette.line3,
      "editorIndentGuide.background1": studioPalette.lineDefault,
      "editorIndentGuide.activeBackground1": studioPalette.line2,
      "editorGutter.background": studioPalette.bg1,
      "editorGutter.modifiedBackground": studioPalette.warn,
      "editorGutter.addedBackground": studioPalette.accent,
      "editorGutter.deletedBackground": studioPalette.error,
      "editorWidget.background": studioPalette.bg2,
      "editorWidget.border": studioPalette.line2,
      "editorSuggestWidget.background": studioPalette.bg2,
      "editorSuggestWidget.border": studioPalette.line2,
      "editorSuggestWidget.selectedBackground": studioPalette.bg3,
      "editorHoverWidget.background": studioPalette.bg2,
      "editorHoverWidget.border": studioPalette.line2,
      "editorBracketMatch.background": studioPalette.bg2,
      "editorBracketMatch.border": studioPalette.line3,
      "editorOverviewRuler.border": studioPalette.lineDefault,
      "minimap.background": studioPalette.bg1,
      "minimapSlider.background": studioPalette.bg3,
      "minimapSlider.hoverBackground": studioPalette.line2,
      "minimapSlider.activeBackground": studioPalette.line3,
      "scrollbarSlider.background": studioPalette.bg3,
      "scrollbarSlider.hoverBackground": studioPalette.line2,
      "scrollbarSlider.activeBackground": studioPalette.line3,
      "diffEditor.insertedTextBackground": "#4eba8722",
      "diffEditor.removedTextBackground": "#d9616822",
      "diffEditor.insertedLineBackground": "#4eba8714",
      "diffEditor.removedLineBackground": "#d9616814",
      "editorError.foreground": studioPalette.error,
      "editorWarning.foreground": studioPalette.warn,
      "editorInfo.foreground": studioPalette.teal,
      focusBorder: studioPalette.accent,
    },
  } satisfies Parameters<Monaco["editor"]["defineTheme"]>[1];
}

function stripHash(value: string): string {
  return value.startsWith("#") ? value.slice(1) : value;
}
