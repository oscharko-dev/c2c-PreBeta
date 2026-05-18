import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

// Source-level invariants — codify the wiring agreements with the
// downstream slices and the review findings on PR #258. The Monaco
// runtime is too heavy to mount in jsdom, so we assert on the source
// shape instead. The properties asserted here are exactly the ones
// that, if dropped, would silently regress the bug the review flagged.

const STUDIO_ROOT = resolve(__dirname, "..", "..", "..");
const INNER_PATH = resolve(
  STUDIO_ROOT,
  "src/components/editor/CodeEditorInner.tsx",
);
const TYPES_PATH = resolve(
  STUDIO_ROOT,
  "src/components/editor/codeEditorTypes.ts",
);

const innerSource = readFileSync(INNER_PATH, "utf8");
const typesSource = readFileSync(TYPES_PATH, "utf8");

describe("CodeEditorInner — review-flagged wiring invariants (#258)", () => {
  it("passes the resolved URI to the standalone Editor via `path` so models are URI-scoped", () => {
    // Codex finding: without path, URI-scoped diagnostics / language-service
    // state / undo history would not line up with modelUri.
    expect(innerSource).toMatch(/path=\{resolvedUri\}/);
  });

  it("passes both diff URIs through to @monaco-editor/react's DiffEditor", () => {
    expect(innerSource).toMatch(/originalModelPath=\{resolvedOriginalUri\}/);
    expect(innerSource).toMatch(/modifiedModelPath=\{resolvedUri\}/);
  });

  it("derives a distinct original-side URI when none is provided", () => {
    expect(innerSource).toMatch(
      /originalModelUri \?\? `\$\{resolvedUri\}~original`/,
    );
  });

  it("suppresses onChange in readonly mode (Codex finding)", () => {
    // The onChange handler must early-return when mode is "readonly" so
    // programmatic value refreshes don't mark consumer buffers dirty.
    expect(innerSource).toMatch(
      /if \(mode === ["']readonly["']\) \{\s*return;\s*\}/,
    );
  });

  it("suppresses onChange for whole-model replacements (isFlush)", () => {
    // The onChange handler must early-return when ev.isFlush is true so
    // @monaco-editor/react's `value`-prop flushes don't mark dirty.
    // Match both the standalone form (`event?.isFlush`) and the diff form
    // (`event.isFlush`) — they appear in separate code paths.
    expect(innerSource).toMatch(/event\?\.\s*isFlush/);
    expect(innerSource).toMatch(/event\.isFlush/);
  });

  it("tracks the diff onDidChangeContent disposable in a ref", () => {
    // Copilot finding: the listener returned by onDidChangeContent
    // returns an IDisposable that must be cleaned up on unmount.
    expect(innerSource).toMatch(/contentChangeDisposableRef/);
    expect(innerSource).toMatch(
      /contentChangeDisposableRef\.current\s*=\s*modifiedModel\.onDidChangeContent/,
    );
  });

  it("disposes the diff content-change listener in the cleanup effect", () => {
    expect(innerSource).toMatch(
      /contentChangeDisposableRef\.current\.dispose\(\)/,
    );
    expect(innerSource).toMatch(
      /contentChangeDisposableRef\.current\s*=\s*null/,
    );
  });
});

describe("DiffCodeEditorProps surface (#258)", () => {
  it("exposes an optional originalModelUri prop", () => {
    expect(typesSource).toMatch(/originalModelUri\?:\s*string/);
  });
});
