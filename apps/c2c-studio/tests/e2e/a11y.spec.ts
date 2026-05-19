// Studio-IDE-12 (#250) — axe-core accessibility gate.
//
// Runs axe-core against the Studio workbench shell with the WCAG 2.2 AA
// rule pack enabled and asserts zero ``serious`` or ``critical``
// violations. The test is tagged ``@a11y`` so the CI workflow runs it
// alongside the contract suite while keeping the slower ``@perf`` and
// ``@memory`` tags non-blocking initially.
//
// Coverage: the shell exercise covers the eight workbench regions
// Issue #250 §Accessibility enumerates (top bar, activity bar,
// secondary stripe, bottom workbench, status bar, sample selector,
// Monaco editor surface, problems panel access). The dedicated
// conflict-resolver dialog and editor-assist side panel run only when
// the user opens them; those are exercised by dedicated tests in the
// follow-up axe-core extension (see PR description P1 list).

import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const SEVERE_IMPACTS = new Set(["serious", "critical"]);

test.describe("@a11y workbench shell", () => {
  test("axe-core reports zero serious/critical violations", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.getByTestId("studio-workbench-shell")).toBeVisible();
    await page.waitForLoadState("networkidle");

    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();

    const severe = results.violations.filter((v) =>
      SEVERE_IMPACTS.has(v.impact ?? ""),
    );
    if (severe.length > 0) {
      const detail = severe
        .map((v) => {
          const nodeDetails = v.nodes
            .map((node, i) => {
              const target =
                Array.isArray(node.target) && node.target.length > 0
                  ? String(node.target[0])
                  : "?";
              const summary = (node.failureSummary ?? "").replace(/\n/g, " ");
              return `    [${i + 1}] target=${target} :: ${summary}`;
            })
            .join("\n");
          return `* [${v.impact}] ${v.id} — ${v.help} (${v.nodes.length} node(s))\n${nodeDetails}`;
        })
        .join("\n");
      throw new Error(
        `axe-core reported ${severe.length} serious/critical violation(s):\n${detail}`,
      );
    }
    expect(severe).toHaveLength(0);
  });
});
