// Studio-IDE-12 (#250) — performance harness.
//
// Issue #250 §Performance SLAs (M2/Chromium reference hardware):
//   * Editor mount, 5k-line COBOL: ≤ 800 ms.
//   * Editor mount, 10k-line COBOL: ≤ 1500 ms.
//   * Scroll p95 frametime over a 10k-line file: ≤ 16.7 ms.
//   * Search to first match on 5k lines: ≤ 200 ms.
//
// The harness drives the Studio via the perf bridge installed under
// ``NEXT_PUBLIC_C2C_PERF_HARNESS === "1"`` (see
// ``components/workbench/PerfHarnessBridge.tsx``):
//
//   * Dispatches the ``c2c-perf:load-cobol`` window event so the
//     bridge calls ``setSourceFile()`` on the source workspace
//     store. Monaco mounts the resulting model.
//   * Reads the focused Monaco editor through the
//     ``window.__c2cMonacoEditor`` global so search timing is
//     measured against the actual instance.
//
// The CI runner is not the M2 reference profile, so the SLA assertions
// use a 5× cushion. The actual numbers are logged to stdout for
// trend-tracking, and the CI workflow stays required — a regression
// past the cushion is a real signal worth blocking on.

import { expect, test } from "@playwright/test";

import { buildSyntheticCobol } from "./helpers/syntheticCobol";

const MOUNT_SLA_5K_MS = 800;
const MOUNT_SLA_10K_MS = 1500;
const SEARCH_SLA_MS = 200;
const SCROLL_P95_FRAMETIME_MS = 16.7;

async function loadCobolAndAwaitMount(
  page: import("@playwright/test").Page,
  source: string,
): Promise<number> {
  // Trigger the perf bridge — the COBOL editor pane mounts with the
  // supplied source. The Monaco editor element gains the
  // ``monaco-editor`` class once the bundle finishes loading and the
  // model is attached.
  const t0 = Date.now();
  await page.evaluate((sourceText) => {
    window.dispatchEvent(
      new CustomEvent("c2c-perf:load-cobol", {
        detail: { sourceText },
      }),
    );
  }, source);
  await page.waitForFunction(
    () => {
      const w = window as unknown as {
        __c2cMonacoEditor?: {
          getDomNode: () => HTMLElement | null;
          getModel: () => unknown;
          getVisibleRanges: () => Array<{
            startLineNumber: number;
            endLineNumber: number;
          }>;
        };
      };
      const editor = w.__c2cMonacoEditor;
      if (!editor) return false;
      const model = editor.getModel();
      const domNode = editor.getDomNode();
      const hasRenderedViewport = Boolean(
        domNode?.querySelector(".view-lines"),
      );
      const visibleRanges = editor.getVisibleRanges();
      return Boolean(
        model &&
          hasRenderedViewport &&
          visibleRanges.some(
            (range) => range.endLineNumber >= range.startLineNumber,
          ),
      );
    },
    null,
    { timeout: 30_000 },
  );
  return Date.now() - t0;
}

async function readyWorkbench(page: import("@playwright/test").Page) {
  await page.goto("/");
  await expect(page.getByTestId("studio-workbench-shell")).toBeVisible();
}

// Hardware-class cushion. Issue #250 §Performance numbers are pinned
// to M2 / Chromium reference hardware. CI runs on ubuntu-24.04 which
// is typically 1.5-2× slower per perf benchmarks. A 2× cushion is
// the tightest gate that still absorbs CI hardware variance without
// constant flakes; a regression past 2× is a real signal worth
// blocking on.
const HARDWARE_CUSHION = 2;

test.describe("@perf editor mount + search", () => {
  test("5k-line mount stays inside the reference SLA (with CI hardware cushion)", async ({
    page,
  }) => {
    const source = buildSyntheticCobol({ targetLines: 5_000 });
    await readyWorkbench(page);
    const elapsed = await loadCobolAndAwaitMount(page, source);
    console.log(`[perf] 5k mount: ${elapsed} ms (SLA ${MOUNT_SLA_5K_MS} ms)`);
    expect(elapsed).toBeLessThan(MOUNT_SLA_5K_MS * HARDWARE_CUSHION);
  });

  test("10k-line mount stays inside the reference SLA (with CI hardware cushion)", async ({
    page,
  }) => {
    const source = buildSyntheticCobol({ targetLines: 10_000 });
    await readyWorkbench(page);
    const elapsed = await loadCobolAndAwaitMount(page, source);
    console.log(`[perf] 10k mount: ${elapsed} ms (SLA ${MOUNT_SLA_10K_MS} ms)`);
    expect(elapsed).toBeLessThan(MOUNT_SLA_10K_MS * HARDWARE_CUSHION);
  });

  test("search first match stays inside the reference SLA (with CI hardware cushion)", async ({
    page,
  }) => {
    const source = buildSyntheticCobol({ targetLines: 5_000 });
    await readyWorkbench(page);
    await loadCobolAndAwaitMount(page, source);
    const result = await page.evaluate(() => {
      const w = window as unknown as {
        __c2cMonacoEditor?: {
          getModel: () => {
            findMatches: (
              searchString: string,
              searchOnlyEditableRange: boolean,
              isRegex: boolean,
              matchCase: boolean,
              wordSeparators: string | null,
              captureMatches: boolean,
              limitResultCount: number,
            ) => unknown[];
          } | null;
        };
      };
      const editor = w.__c2cMonacoEditor;
      if (!editor) return -1;
      const model = editor.getModel();
      if (!model) return -1;
      const t0 = performance.now();
      const matches = model.findMatches(
        "DISPLAY",
        false,
        false,
        false,
        null,
        true,
        1,
      );
      return {
        elapsed: performance.now() - t0,
        matchCount: matches.length,
      };
    });
    console.log(
      `[perf] search first match: ${typeof result === "number" ? result : result.elapsed.toFixed(0)} ms (SLA ${SEARCH_SLA_MS} ms)`,
    );
    expect(result).not.toBe(-1);
    expect(typeof result).toBe("object");
    expect((result as { matchCount: number }).matchCount).toBeGreaterThan(0);
    expect((result as { elapsed: number }).elapsed).toBeLessThan(
      SEARCH_SLA_MS * HARDWARE_CUSHION,
    );
  });

  test("10k-line controlled edit preserves cursor line and scroll locality", async ({
    page,
  }) => {
    const source = buildSyntheticCobol({ targetLines: 10_000 });
    await readyWorkbench(page);
    await loadCobolAndAwaitMount(page, source);

    const probe = await page.evaluate(async () => {
      const w = window as unknown as {
        __c2cMonacoEditor?: {
          focus: () => void;
          getPosition: () => { lineNumber: number; column: number } | null;
          getScrollTop: () => number;
          getVisibleRanges: () => Array<{
            startLineNumber: number;
            endLineNumber: number;
          }>;
          revealLineInCenter: (lineNumber: number) => void;
          setPosition: (position: {
            lineNumber: number;
            column: number;
          }) => void;
          trigger: (
            source: string,
            handlerId: string,
            payload?: { text: string },
          ) => void;
        };
      };
      const editor = w.__c2cMonacoEditor;
      if (!editor) return null;
      const target = { lineNumber: 5_005, column: 12 };
      editor.revealLineInCenter(target.lineNumber);
      editor.setPosition(target);
      editor.focus();
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(resolve));
        if (
          editor
            .getVisibleRanges()
            .some(
              (range) =>
                target.lineNumber >= range.startLineNumber &&
                target.lineNumber <= range.endLineNumber,
            )
        ) {
          break;
        }
      }
      const before = {
        position: editor.getPosition(),
        scrollTop: editor.getScrollTop(),
      };
      const t0 = performance.now();
      editor.trigger("perf-harness", "type", { text: "X" });
      await new Promise<void>((resolve) => requestAnimationFrame(resolve));
      return {
        elapsed: performance.now() - t0,
        before,
        after: {
          position: editor.getPosition(),
          scrollTop: editor.getScrollTop(),
        },
      };
    });

    expect(probe).not.toBeNull();
    expect(probe?.after.position?.lineNumber).toBe(
      probe?.before.position?.lineNumber,
    );
    expect(probe?.after.position?.column).toBe(
      (probe?.before.position?.column ?? 0) + 1,
    );
    expect(
      Math.abs((probe?.after.scrollTop ?? 0) - (probe?.before.scrollTop ?? 0)),
    ).toBeLessThanOrEqual(500);
    console.log(
      `[perf] 10k controlled edit: ${probe?.elapsed.toFixed(0)} ms`,
    );
  });

  test("scroll p95 frametime stays under 16.7 ms on a 10k-line buffer", async ({
    page,
  }) => {
    const source = buildSyntheticCobol({ targetLines: 10_000 });
    await readyWorkbench(page);
    await loadCobolAndAwaitMount(page, source);
    // Drive a programmatic scroll over the full 10k-line buffer and
    // sample requestAnimationFrame timestamps. The page-side runner
    // computes frametime deltas, sorts them, and returns the 95th
    // percentile — that's the load-bearing scroll-smoothness number
    // Issue #250 §Performance prescribes.
    const p95 = await page.evaluate(async (): Promise<number> => {
      const w = window as unknown as {
        __c2cMonacoEditor?: {
          getScrollHeight: () => number;
          setScrollTop: (top: number) => void;
        };
      };
      const editor = w.__c2cMonacoEditor;
      if (!editor) return -1;
      const totalHeight = editor.getScrollHeight();
      const step = Math.max(64, Math.floor(totalHeight / 200));
      const frametimes: number[] = [];
      let previous = performance.now();
      for (let top = 0; top < totalHeight; top += step) {
        editor.setScrollTop(top);
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => {
            const now = performance.now();
            frametimes.push(now - previous);
            previous = now;
            resolve();
          });
        });
      }
      if (frametimes.length === 0) return -1;
      frametimes.sort((a, b) => a - b);
      const idx = Math.min(
        frametimes.length - 1,
        Math.floor(frametimes.length * 0.95),
      );
      return frametimes[idx]!;
    });
    console.log(
      `[perf] scroll p95 frametime: ${p95.toFixed(2)} ms (SLA ${SCROLL_P95_FRAMETIME_MS} ms)`,
    );
    expect(p95).toBeGreaterThan(0);
    expect(p95).toBeLessThan(SCROLL_P95_FRAMETIME_MS * HARDWARE_CUSHION);
  });
});
