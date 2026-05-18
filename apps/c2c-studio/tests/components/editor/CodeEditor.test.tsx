import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { EditorSkeleton } from "@/components/editor/EditorSkeleton";
import { applySanitization } from "@/components/editor/codeEditorTypes";

const STUDIO_ROOT = resolve(__dirname, "..", "..", "..");

describe("CodeEditor wrapper", () => {
  it("uses next/dynamic with ssr: false so Monaco loads only on the client", () => {
    const source = readFileSync(
      resolve(STUDIO_ROOT, "src/components/editor/CodeEditor.tsx"),
      "utf8",
    );
    expect(source).toMatch(/from\s+['"]next\/dynamic['"]/);
    expect(source).toMatch(/ssr:\s*false/);
    expect(source).toMatch(/import\(['"]\.\/CodeEditorInner['"]\)/);
  });

  it("does not statically import monaco-editor or @monaco-editor/react in the wrapper", () => {
    const source = readFileSync(
      resolve(STUDIO_ROOT, "src/components/editor/CodeEditor.tsx"),
      "utf8",
    );
    expect(source).not.toMatch(/from\s+['"]monaco-editor/);
    expect(source).not.toMatch(/from\s+['"]@monaco-editor\/react['"]/);
  });

  it("exposes the three supported modes via its typed surface", () => {
    const typesSource = readFileSync(
      resolve(STUDIO_ROOT, "src/components/editor/codeEditorTypes.ts"),
      "utf8",
    );
    expect(typesSource).toMatch(/['"]editable['"]/);
    expect(typesSource).toMatch(/['"]readonly['"]/);
    expect(typesSource).toMatch(/['"]diff['"]/);
  });
});

describe("EditorSkeleton", () => {
  it("renders with a polite live region and the default loading label", () => {
    render(<EditorSkeleton />);
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-label", "Loading editor");
    expect(status).toHaveAttribute("aria-live", "polite");
  });

  it("honors a custom label so consumers can describe what is loading", () => {
    render(<EditorSkeleton label="Loading Java source" />);
    expect(screen.getByRole("status")).toHaveAttribute(
      "aria-label",
      "Loading Java source",
    );
  });
});

describe("applySanitization", () => {
  it('returns input unchanged when profile is "none" or undefined', () => {
    expect(applySanitization("abc  \n", "none")).toBe("abc  \n");
    expect(applySanitization("abc  \n", undefined)).toBe("abc  \n");
  });

  it("strips trailing whitespace per line", () => {
    expect(
      applySanitization("abc   \nxyz\t\n", "strip-trailing-whitespace"),
    ).toBe("abc\nxyz\n");
  });

  it("normalizes CR/CRLF newlines to LF", () => {
    expect(applySanitization("a\r\nb\rc\n", "normalize-newlines")).toBe(
      "a\nb\nc\n",
    );
  });
});
