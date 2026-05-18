// Studio-IDE-7 (#252) E2E: Run BRNCH01 → edit COBOL → re-run → open Compare
// Runs → assert that both Java and COBOL diffs render and the Linked-scroll
// toggle is honored.
//
// This test follows the same live-stack pattern as workflow.spec.ts — the
// Playwright webServer (./scripts/start-c2c-local.sh --ci) brings up the
// orchestrator, BFF, and the Next.js workbench, and the spec drives the
// real UI through two consecutive transformations.

import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page, type Response } from "@playwright/test";

const COBOL_EDITOR_LABEL = /COBOL source editor/i;
const PRODUCT_PATH_COBOL = readFileSync(
  path.resolve(
    __dirname,
    "../../../../corpus/synthetic/programs/branch-account-guard.cbl",
  ),
  "utf8",
);

const BFF_BASE_URL =
  process.env.NEXT_PUBLIC_C2C_BFF_BASE_URL || "http://127.0.0.1:18089";

async function expectReadyWorkbench(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("studio-workbench-shell")).toBeVisible();
  await expect(page.getByLabel("Product readiness")).toContainText("Ready");
}

function topBarStartButton(page: Page) {
  return page
    .getByLabel("Workbench Top Bar")
    .getByRole("button", { name: "Start Transformation" });
}

async function enterCobolSource(page: Page, content: string) {
  await page.getByRole("button", { name: "Start Typing" }).click();
  const editor = page.getByRole("textbox", { name: COBOL_EDITOR_LABEL });
  await editor.fill(content);
  await expect(
    page
      .locator(".view-line")
      .filter({ hasText: /PROGRAM-ID\. BRNCH01\./ })
      .first(),
  ).toBeVisible();
}

async function replaceCobolSource(page: Page, content: string) {
  const editor = page.getByRole("textbox", { name: COBOL_EDITOR_LABEL });
  await editor.focus();
  // Select all + replace. Cmd+A on macOS, Ctrl+A elsewhere — Monaco honors
  // both. We use ControlOrMeta which Playwright maps platform-appropriately.
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Delete");
  await editor.fill(content);
}

async function waitForJsonResponse(
  page: Page,
  matcher: (response: Response) => boolean,
  timeout = 120_000,
): Promise<unknown> {
  const response = await page.waitForResponse(matcher, { timeout });
  return response.json();
}

async function runTransformAndWait(
  page: Page,
): Promise<{ runId: string; entryFilePath: string }> {
  const transformResponsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/v0/transform") &&
      response.status() === 201,
    { timeout: 120_000 },
  );

  await topBarStartButton(page).click();

  const transformResponse = await transformResponsePromise;
  const transformBody = (await transformResponse.json()) as {
    runId?: string;
  };
  const runId = String(transformBody.runId);
  expect(runId).toBeTruthy();

  // Wait for the generated-files manifest so we know the run has produced
  // Java that the diff-history accumulator can snapshot.
  const generatedFilesBody = (await waitForJsonResponse(
    page,
    (response) =>
      response.url().endsWith(`/api/v0/runs/${runId}/generated/files`) &&
      response.ok(),
  )) as { entryFilePath?: string; files: Array<{ path: string }> };

  const entryFilePath =
    generatedFilesBody.entryFilePath ?? generatedFilesBody.files[0]?.path;
  expect(entryFilePath).toBeTruthy();

  // Wait for the run to reach a verified / completed state by polling the
  // Java pane's data-file-sha256 attribute, which is only stamped once the
  // BFF returns content for the selected file.
  const javaPane = page.locator(
    '[data-testid="generated-java-editor-surface"]',
  );
  await expect(javaPane).toHaveAttribute("data-file-sha256", /.+/, {
    timeout: 120_000,
  });
  // Allow the recordJavaDiffSnapshot effect to fire (deriveSourceHash +
  // setState). 500 ms is comfortably above the buffer-debounce window.
  await page.waitForTimeout(750);

  return { runId, entryFilePath: String(entryFilePath) };
}

function buildEditedCobol(source: string): string {
  // Targeted edit: insert a benign comment line just before ``STOP RUN.``.
  // The orchestrator is content-addressed so any byte-level change
  // produces a new runId; we use a COBOL comment so the program's
  // observable behavior is unchanged and the equivalence oracle still
  // classifies the run as ``success``.
  const marker = "           STOP RUN.";
  const idx = source.indexOf(marker);
  if (idx < 0) {
    return `${source}\n      *> IDE-7 e2e edit`;
  }
  return source.slice(0, idx) + "      *> IDE-7 e2e edit\n" + source.slice(idx);
}

test.describe("Studio-IDE-7 synchronized diff workflow", () => {
  test("Compare Runs opens the diff workspace after two consecutive runs", async ({
    page,
  }) => {
    await expectReadyWorkbench(page);
    await enterCobolSource(page, PRODUCT_PATH_COBOL);

    // First run.
    const first = await runTransformAndWait(page);

    // Second run: edit COBOL, re-submit.
    const edited = buildEditedCobol(PRODUCT_PATH_COBOL);
    expect(edited).not.toEqual(PRODUCT_PATH_COBOL);
    await replaceCobolSource(page, edited);
    const second = await runTransformAndWait(page);
    expect(second.runId).not.toEqual(first.runId);

    // The Compare Runs button is rendered on the Java pane toolbar
    // whenever the user has a selected file and an active programId.
    const compareButton = page.getByTestId("java-compare-runs-button");
    await expect(compareButton).toBeVisible();
    await compareButton.click();

    // The diff workspace overlay must appear with both diff editors.
    const workspace = page.getByTestId("diff-workspace");
    await expect(workspace).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("diff-workspace-java")).toBeVisible();
    await expect(page.getByTestId("diff-workspace-cobol")).toBeVisible();

    // Linked scroll toggle is present. It may be enabled or disabled
    // depending on whether traceability resolved lineage for the
    // selected file; in the live BRNCH01 path the IR anchors are
    // present so the toggle is enabled.
    const linkedToggle = page.getByLabel("Linked scroll");
    await expect(linkedToggle).toBeVisible();
    // If the toggle is enabled we exercise it — flipping must update the
    // `data-linked-scroll` attribute synchronously.
    const isDisabled = await linkedToggle.isDisabled();
    if (!isDisabled) {
      await expect(workspace).toHaveAttribute("data-linked-scroll", "true");
      await linkedToggle.click();
      await expect(workspace).toHaveAttribute("data-linked-scroll", "false");
      await linkedToggle.click();
      await expect(workspace).toHaveAttribute("data-linked-scroll", "true");
    } else {
      // Spec-permitted fallback: the un-coupled notice MUST be visible.
      await expect(
        page.getByTestId("diff-workspace-uncoupled-notice"),
      ).toBeVisible();
    }

    // Close the workspace and confirm we are back on the editor pane.
    await page.getByLabel("Close compare runs").click();
    await expect(workspace).toHaveCount(0);
    await expect(
      page.locator('[data-testid="generated-java-editor-surface"]'),
    ).toBeVisible();

    // Sanity: BFF traceability surface really is keyed by runId per
    // expectations, so the spec stays informative even if the lineage
    // toggle was disabled above.
    const traceUrl = `${BFF_BASE_URL}/api/v0/runs/${encodeURIComponent(second.runId)}/traceability`;
    const traceStatus = await page.evaluate(async (url) => {
      const r = await fetch(url);
      return r.status;
    }, traceUrl);
    expect([200, 404]).toContain(traceStatus);
  });
});
