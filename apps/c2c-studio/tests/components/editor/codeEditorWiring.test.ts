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
  it("routes diff mode to the DiffEditor view and readonly mode to Monaco readOnly", () => {
    expect(innerSource).toMatch(/props\.mode === ["']diff["']/);
    expect(innerSource).toMatch(/readOnly:\s*mode === ["']readonly["']/);
  });

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
    // Review finding: the listener returned by onDidChangeContent
    // returns an IDisposable that must be cleaned up on unmount.
    expect(innerSource).toMatch(/contentChangeDisposableRef/);
    expect(innerSource).toMatch(
      /contentChangeDisposableRef\.current\s*=\s*[\s\S]*?\.onDidChangeContent/,
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

  it("re-attaches the diff content-change listener when the modified model is swapped (Codex round-2)", () => {
    // When modelUri changes while the diff editor stays mounted,
    // @monaco-editor/react swaps the modified model. Without re-wiring,
    // edits in the new pane silently stop calling onChange.
    expect(innerSource).toMatch(/modifiedEditor\.onDidChangeModel/);
    expect(innerSource).toMatch(/modelChangeDisposableRef/);
    expect(innerSource).toMatch(
      /modelChangeDisposableRef\.current\.dispose\(\)/,
    );
  });

  it("derives a per-instance fallback URI so independent editors do not share Monaco models (Codex round-2)", () => {
    // Two CodeEditors with the same language and no explicit modelUri must
    // not resolve to the same `path` — @monaco-editor/react would reuse one
    // Monaco model for both, causing one to overwrite or mirror the other.
    expect(innerSource).toMatch(/useId/);
    expect(innerSource).toMatch(/fallbackUriId/);
    expect(innerSource).toMatch(
      /inmemory:\/\/model\/\$\{language\}\/\$\{fallbackUriId\}/,
    );
    expect(innerSource).toMatch(
      /inmemory:\/\/model\/\$\{language\}-diff\/\$\{fallbackUriId\}/,
    );
  });

  it("only disposes the diff onDidChangeModel + content listeners on unmount, not on URI change (Codex round-3)", () => {
    // The cleanup effect that disposes long-lived listeners must depend on
    // `[]` (mount/unmount only), not on `[resolvedUri]`. Tying it to the URI
    // would tear down the listener infrastructure on every URI swap and
    // leave subsequent model swaps unwired.
    expect(innerSource).toMatch(
      /\/\/ Dispose long-lived editor resources only on actual unmount[\s\S]*?\}, \[\]\);/,
    );
    expect(innerSource).toMatch(
      /\/\/ Dispose long-lived listeners only on actual unmount[\s\S]*?\}, \[\]\);/,
    );
  });

  it("re-applies markers to the current model on model swap via markersRef (Codex round-3)", () => {
    // Both editor variants must read the latest markers via a ref so the
    // onDidChangeModel handler does not capture stale markers from onMount.
    // Studio-IDE-5 (#244): `applyMarkers` now also threads `markerGroupsRef`
    // and a `previousOwnersRef` so the per-owner marker isolation survives
    // model swaps; the markersRef.current pattern must remain.
    expect(innerSource).toMatch(/markersRef\s*=\s*useRef/);
    expect(innerSource).toMatch(/markersRef\.current\s*=\s*markers/);
    expect(innerSource).toMatch(/applyMarkers\([^)]*markersRef\.current/);
  });

  it("standalone editor refreshes markers when the model is swapped (Codex round-3)", () => {
    // The standalone editor must wire `onDidChangeModel` to re-apply markers
    // to whatever model @monaco-editor/react swapped in. Previously the
    // marker effect only re-ran on markers changes, so a path change with
    // unchanged markers left the new model unmarked.
    const standaloneSection = innerSource.slice(
      innerSource.indexOf("function StandaloneEditorView"),
      innerSource.indexOf("function DiffEditorView"),
    );
    expect(standaloneSection).toMatch(/editor\.onDidChangeModel/);
    expect(standaloneSection).toMatch(/modelChangeDisposableRef/);
  });

  it("restores view state on model swap, not only at onMount (Codex round-4)", () => {
    // When `modelUri` changes mid-flight, @monaco-editor/react swaps the
    // model. The new URI may already have saved view state; without
    // restoring on the swap, the freshly-selected document loses cursor
    // and scroll position.
    expect(innerSource).toMatch(/resolvedUriRef/);
    expect(innerSource).toMatch(
      /restoreViewState\([\s\S]*?resolvedUriRef\.current\s*\)/,
    );
    expect(innerSource).toMatch(
      /restoreDiffViewState\([\s\S]*?resolvedUriRef\.current\s*\)/,
    );
  });

  it("suppresses onChange for executeEdits-driven prop refreshes via value-equality (Codex round-5)", () => {
    // @monaco-editor/react 4.7 applies new `value` / `modified` props via
    // `executeEdits` instead of `setValue`. Those emit content events with
    // `isFlush === false`, so the earlier guard alone is insufficient.
    // Both editor variants must additionally compare the post-change model
    // value against the latest sanitized prop and skip when they match.
    expect(innerSource).toMatch(/sanitizedValueRef/);
    expect(innerSource).toMatch(/sanitizedModifiedRef/);
    // Standalone: `next === sanitizedValueRef.current` short-circuits.
    expect(innerSource).toMatch(/next\s*===\s*sanitizedValueRef\.current/);
    // Diff: `currentModel.getValue() === sanitizedModifiedRef.current`
    // is the same idea phrased against the model.
    expect(innerSource).toMatch(/sanitizedModifiedRef\.current/);
  });

  it("re-applies decorations to the new model on swap (Codex round-4)", () => {
    // The previous decorations collection was bound to the old model. When
    // the model swaps, recreate from `decorationsPropRef` (the latest prop)
    // so highlights survive URI changes even when the decorations array is
    // identity-stable.
    expect(innerSource).toMatch(/decorationsPropRef/);
    // Re-creating from the prop ref must happen in BOTH the standalone
    // and diff swap paths.
    const swapBlocks = innerSource.match(
      /decorationsPropRef\.current[\s\S]*?createDecorationsCollection\(currentDecorations\)/g,
    );
    expect(swapBlocks).not.toBeNull();
    expect((swapBlocks ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("tracks and disposes Monaco addAction registrations for both editor variants", () => {
    // Monaco addAction returns an IDisposable. CodeEditor exposes `actions`
    // as a public prop, so every registration must be paired with cleanup
    // on action changes and unmount to avoid duplicate commands and leaks.
    expect(innerSource).toMatch(/actionDisposablesRef/);
    expect(innerSource).toMatch(/function applyActions/);
    expect(innerSource).toMatch(/editor\.addAction\(action\)/);
    expect(innerSource).toMatch(
      /modifiedEditor,\s*actions,\s*actionDisposablesRef/,
    );
    expect(innerSource).toMatch(
      /disposeActionDisposables\(actionDisposablesRef\)/,
    );
  });
});

describe("DiffCodeEditorProps surface (#258)", () => {
  it("exposes an optional originalModelUri prop", () => {
    expect(typesSource).toMatch(/originalModelUri\?:\s*string/);
  });
});
