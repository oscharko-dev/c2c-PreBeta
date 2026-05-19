import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetThemeForTests,
  applyStudioTheme,
  STUDIO_DARK_THEME,
} from "@/lib/editor/monacoTheme";

import type { Monaco } from "@/lib/editor/lazyMonaco";

function makeMockMonaco(): Monaco {
  return {
    editor: {
      defineTheme: vi.fn(),
      setTheme: vi.fn(),
    },
  } as unknown as Monaco;
}

describe("monacoTheme", () => {
  beforeEach(() => {
    __resetThemeForTests();
  });

  it("defines the studio dark theme from concrete palette colors", () => {
    const monaco = makeMockMonaco();

    applyStudioTheme(monaco);

    expect(monaco.editor.defineTheme).toHaveBeenCalledWith(
      STUDIO_DARK_THEME,
      expect.objectContaining({
        base: "vs-dark",
        inherit: true,
        colors: expect.objectContaining({
          "editor.background": "#0b0d10",
          "editor.foreground": "#d6d9e0",
          "editorCursor.foreground": "#4eba87",
          "editorError.foreground": "#d96168",
          focusBorder: "#4eba87",
        }),
        rules: expect.arrayContaining([
          expect.objectContaining({
            token: "keyword",
            foreground: "b58af0",
          }),
          expect.objectContaining({
            token: "string",
            foreground: "4eba87",
          }),
        ]),
      }),
    );
    expect(monaco.editor.setTheme).toHaveBeenCalledWith(STUDIO_DARK_THEME);
  });

  it("defines the theme once but still applies it on every call", () => {
    const monaco = makeMockMonaco();

    applyStudioTheme(monaco);
    applyStudioTheme(monaco);

    expect(monaco.editor.defineTheme).toHaveBeenCalledTimes(1);
    expect(monaco.editor.setTheme).toHaveBeenCalledTimes(2);
  });
});
