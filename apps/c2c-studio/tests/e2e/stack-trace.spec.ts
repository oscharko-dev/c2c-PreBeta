// Studio-IDE-8 (#253) follow-up E2E: a build/test failure whose `note`
// carries a JVM stack trace must render each frame as a row in the
// Build & Test panel; clicking the resolved frame must dispatch
// `c2c:reveal-cobol` with the COBOL anchor the lineage envelope maps
// the Java line to. The test seeds every BFF endpoint through
// `page.route` so it runs without the live orchestrator stack — fast
// and deterministic.

import { expect, test, type Page } from "@playwright/test";

const MOCK_CORS_HEADERS = {
  "access-control-allow-origin": "http://127.0.0.1:3000",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "Content-Type",
} as const;

async function expectReadyWorkbench(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("studio-workbench-shell")).toBeVisible();
  await expect(page.getByLabel("Product readiness")).toContainText("Ready");
}

function topBarStartButton(page: Page) {
  return page
    .getByLabel("Workbench Top Bar")
    .getByRole("button", { name: "Generate & Verify" });
}

async function enterCobolSource(page: Page, source: string) {
  await page.waitForFunction(
    () =>
      (
        window as unknown as {
          __c2cEditorHarnessReady?: boolean;
        }
      ).__c2cEditorHarnessReady === true,
    null,
    { timeout: 15_000 },
  );
  await page.evaluate((sourceText) => {
    window.dispatchEvent(
      new CustomEvent("c2c-e2e:load-cobol", {
        detail: { sourceText, sourceName: "pasted-source.cbl" },
      }),
    );
  }, source);
  await expect(page.getByTestId("code-editor-standalone")).toBeVisible();
  const aiAssistToggle = page.getByLabel(
    "Allow AI assist after deterministic baseline",
  );
  if (await aiAssistToggle.isChecked()) {
    await aiAssistToggle.click();
  }
  await expect(aiAssistToggle).not.toBeChecked();
  await expect(topBarStartButton(page)).toBeEnabled();
}

test.describe("Studio-IDE-8 stack-trace navigation (#253)", () => {
  test("renders clickable frames and dispatches c2c:reveal-cobol on click", async ({
    page,
  }) => {
    const runId = "run-stack-trace-e2e";
    const programId = "PROG1";
    const javaPath = "src/main/java/com/example/Foo.java";
    const cobolFile = "PROG1.cbl";
    const generatedJava = [
      "package com.example;", //  1
      "public class Foo {", //  2
      "  // move [s-move-a line 10]", //  3
      "  int a = 1;", //  4
      "  // paragraph PARA-MAIN [s-paragraph-main line 22]", //  5
      "  public void bar() {", //  6
      "    // move [s-move-b line 30]", //  7
      "    int b = 2;", //  8
      "  }", //  9
      "}", // 10
    ].join("\n");
    const stackTraceNote = [
      "java.lang.RuntimeException: simulated build failure",
      "  at com.example.Foo.bar(Foo.java:8)",
      "  at sun.reflect.NativeMethodAccessorImpl.invoke0(Native Method)",
      "  ... 3 more",
    ].join("\n");
    const generatedSha = "a".repeat(64);

    // --- BFF mocks --------------------------------------------------------

    await page.route("**/api/v0/health", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: MOCK_CORS_HEADERS,
        body: JSON.stringify({ status: "ok" }),
      });
    });

    await page.route("**/api/v0/transform", async (route) => {
      if (route.request().method() === "OPTIONS") {
        await route.fulfill({ status: 204, headers: MOCK_CORS_HEADERS });
        return;
      }
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        headers: MOCK_CORS_HEADERS,
        body: JSON.stringify({
          runId,
          orchestratorRunId: runId,
          programId,
          status: "starting",
          mode: "live",
          productMode: "live",
          createdAt: "2026-05-15T00:00:00Z",
          updatedAt: "2026-05-15T00:00:00Z",
          links: {
            self: `/api/v0/runs/${runId}`,
            generated: `/api/v0/runs/${runId}/generated`,
            generatedFiles: `/api/v0/runs/${runId}/generated/files`,
            buildTest: `/api/v0/runs/${runId}/build-test`,
            evidence: `/api/v0/runs/${runId}/evidence`,
            events: `/api/v0/runs/${runId}/events`,
            artifacts: `/api/v0/runs/${runId}/artifacts`,
          },
        }),
      });
    });

    await page.route(`**/api/v0/runs/${runId}`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: MOCK_CORS_HEADERS,
        body: JSON.stringify({
          runId,
          orchestratorRunId: runId,
          programId,
          status: "completed",
          mode: "live",
          productMode: "live",
          createdAt: "2026-05-15T00:00:00Z",
          updatedAt: "2026-05-15T00:00:01Z",
          links: {
            self: `/api/v0/runs/${runId}`,
            generated: `/api/v0/runs/${runId}/generated`,
            generatedFiles: `/api/v0/runs/${runId}/generated/files`,
            buildTest: `/api/v0/runs/${runId}/build-test`,
            evidence: `/api/v0/runs/${runId}/evidence`,
            events: `/api/v0/runs/${runId}/events`,
            artifacts: `/api/v0/runs/${runId}/artifacts`,
          },
        }),
      });
    });

    await page.route(`**/api/v0/runs/${runId}/generated`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: MOCK_CORS_HEADERS,
        body: JSON.stringify({
          runId,
          programId,
          mode: "live",
          productMode: "live",
          status: "generated",
          entryClass: "com.example.Foo",
          entryFilePath: javaPath,
          fileCount: 1,
          artifactRef: { sha256: generatedSha, byteSize: generatedJava.length },
        }),
      });
    });

    await page.route(
      `**/api/v0/runs/${runId}/generated/files`,
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          headers: MOCK_CORS_HEADERS,
          body: JSON.stringify({
            runId,
            programId,
            mode: "live",
            productMode: "live",
            status: "complete",
            files: [
              {
                path: javaPath,
                sha256: generatedSha,
                byteSize: generatedJava.length,
                mimeType: "text/x-java-source",
              },
            ],
            fileCount: 1,
            entryFilePath: javaPath,
            artifactRef: {
              sha256: generatedSha,
              byteSize: generatedJava.length,
            },
          }),
        });
      },
    );

    await page.route(
      `**/api/v0/runs/${runId}/generated/files/${javaPath}`,
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          headers: MOCK_CORS_HEADERS,
          body: JSON.stringify({
            runId,
            programId,
            mode: "live",
            productMode: "live",
            path: javaPath,
            content: generatedJava,
            sha256: generatedSha,
            byteSize: generatedJava.length,
            mimeType: "text/x-java-source",
          }),
        });
      },
    );

    await page.route(`**/api/v0/runs/${runId}/build-test`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: MOCK_CORS_HEADERS,
        body: JSON.stringify({
          runId,
          programId,
          mode: "live",
          productMode: "live",
          status: "run-failed",
          classification: "run-error",
          generatedArtifactRef: { sha256: generatedSha },
          note: stackTraceNote,
        }),
      });
    });

    await page.route(`**/api/v0/runs/${runId}/evidence`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: MOCK_CORS_HEADERS,
        body: JSON.stringify({
          runId,
          programId,
          mode: "live",
          productMode: "live",
          status: "incomplete",
          generatedArtifactRef: { sha256: generatedSha },
          missingArtifacts: ["harnessEvents"],
          note: "Evidence skipped because build/test failed.",
        }),
      });
    });

    await page.route(`**/api/v0/runs/${runId}/events`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: MOCK_CORS_HEADERS,
        body: JSON.stringify({
          runId,
          programId,
          mode: "live",
          productMode: "live",
          events: [],
        }),
      });
    });

    await page.route(`**/api/v0/runs/${runId}/experience`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: MOCK_CORS_HEADERS,
        body: JSON.stringify({
          runId,
          programId,
          mode: "live",
          productMode: "live",
          summary: "n/a",
        }),
      });
    });

    await page.route(`**/api/v0/runs/${runId}/artifacts`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: MOCK_CORS_HEADERS,
        body: JSON.stringify({
          runId,
          programId,
          mode: "live",
          productMode: "live",
          artifacts: [],
          missingArtifacts: ["harnessEvents"],
        }),
      });
    });

    // Studio-IDE-6 traceability envelope. The mapper needs a region that
    // covers line 8 (deterministic) plus an irSymbolMap entry that
    // s-move-b (the inline anchor nearest to line 8 on line 7) points
    // back at — that is COBOL line 30.
    await page.route(`**/api/v0/runs/${runId}/traceability`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: MOCK_CORS_HEADERS,
        body: JSON.stringify({
          schemaVersion: "v0",
          runId,
          programId,
          trace: null,
          irSymbolMap: {
            "s-move-a": { cobolFile, cobolLine: 10 },
            "s-paragraph-main": { cobolFile, cobolLine: 22 },
            "s-move-b": { cobolFile, cobolLine: 30 },
          },
          javaRegionClassification: {
            [javaPath]: [
              {
                schemaVersion: "v0",
                lineRange: { startLine: 1, endLine: 10 },
                originClass: "deterministic",
                verificationOutcome: "oracle_passed",
                mappingClass: "direct",
              },
            ],
          },
        }),
      });
    });

    // --- UI flow ----------------------------------------------------------

    await expectReadyWorkbench(page);
    await enterCobolSource(
      page,
      `       IDENTIFICATION DIVISION.
       PROGRAM-ID. PROG1.
       PROCEDURE DIVISION.
           DISPLAY 'HELLO'.
           STOP RUN.`,
    );
    await topBarStartButton(page).click();

    // Build & Test tab carries the failure note that the StackTraceView
    // parses. The bottom workbench may need an explicit tab click.
    await page.getByRole("tab", { name: /Build.*Test/i }).click();

    // The view renders one row per parsed frame. The native-method frame
    // is dropped by the parser, leaving exactly one frame for Foo.java:8.
    const view = page.getByTestId("stack-trace-view");
    await expect(view).toBeVisible();
    const rows = view.getByTestId("stack-frame-row");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toHaveAttribute("data-resolved", "true");

    // Subscribe to the COBOL reveal event from the page context. We
    // resolve a promise the first time the event fires so the click
    // below can assert on its detail.
    await page.evaluate(() => {
      const w = window as unknown as {
        __c2cRevealCobolDetails?: Array<{
          cobolFile: string;
          cobolLine: number;
        }>;
      };
      w.__c2cRevealCobolDetails = [];
      window.addEventListener("c2c:reveal-cobol", (ev) => {
        const detail = (ev as CustomEvent).detail as {
          cobolFile: string;
          cobolLine: number;
        };
        w.__c2cRevealCobolDetails!.push(detail);
      });
    });

    // Activate the resolved frame's COBOL link by keyboard. The button's
    // aria-label encodes the COBOL target so we can locate it without
    // coupling to visible text formatting.
    const revealCobol = view.getByRole("button", {
      name: /Reveal COBOL line 30 in PROG1\.cbl/,
    });
    await revealCobol.focus();
    await expect(revealCobol).toBeFocused();
    await page.keyboard.press("Enter");

    const captured = await page.evaluate(() => {
      const w = window as unknown as {
        __c2cRevealCobolDetails?: Array<{
          cobolFile: string;
          cobolLine: number;
        }>;
      };
      return w.__c2cRevealCobolDetails ?? [];
    });
    expect(captured).toEqual([{ cobolFile: "PROG1.cbl", cobolLine: 30 }]);

    // AC4: Show raw toggle reveals the unparsed text (incl. native frame).
    const showRaw = view.getByRole("button", { name: /Show raw/i });
    await showRaw.focus();
    await expect(showRaw).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(
      view.getByText(/NativeMethodAccessorImpl\.invoke0/),
    ).toBeVisible();
  });
});
