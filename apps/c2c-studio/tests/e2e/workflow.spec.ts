import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page, type Response } from "@playwright/test";

const PRODUCT_PATH_COBOL = readFileSync(
  path.resolve(
    __dirname,
    "../../../../corpus/synthetic/programs/branch-account-guard.cbl",
  ),
  "utf8",
);
const BFF_BASE_URL =
  process.env.NEXT_PUBLIC_C2C_BFF_BASE_URL || "http://127.0.0.1:18089";
const MODEL_GATEWAY_FLAG =
  process.env.C2C_LOCAL_MODEL_GATEWAY_ENABLED?.trim().toLowerCase();
const EXPECT_MODEL_POLICY_SKIPPED =
  MODEL_GATEWAY_FLAG === "false" || MODEL_GATEWAY_FLAG === "0";
const MOCK_CORS_HEADERS = {
  "access-control-allow-origin": "http://127.0.0.1:3000",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "Content-Type",
};
interface ProgressResponse {
  runId?: string;
  status?: string;
  steps: Array<{ name: string; status?: string }>;
}

interface GeneratedFilesResponse {
  runId: string;
  entryFilePath?: string;
  files: Array<{ path: string; sha256?: string }>;
}

interface GeneratedFileContentResponse {
  runId: string;
  path: string;
  content: string;
  sha256: string;
}

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
      Boolean(
        (window as unknown as { __c2cEditorHarnessReady?: boolean })
          .__c2cEditorHarnessReady,
      ),
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
  const editorSurface = page.getByTestId("code-editor-standalone");
  await expect(editorSurface).toBeVisible();
  const aiAssistToggle = page.getByLabel(
    "Allow AI assist after deterministic baseline",
  );
  if (await aiAssistToggle.isChecked()) {
    await aiAssistToggle.click();
  }
  await expect(aiAssistToggle).not.toBeChecked();
  await expect(topBarStartButton(page)).toBeEnabled();
}

async function enterProductPathCobol(page: Page) {
  await enterCobolSource(page, PRODUCT_PATH_COBOL);
}

async function waitForJsonResponse(
  page: Page,
  matcher: (response: Response) => boolean,
  timeout = 120_000,
) {
  const response = await page.waitForResponse(matcher, { timeout });
  return response.json();
}

async function fetchJsonFromPage(page: Page, path: string): Promise<unknown> {
  return page.evaluate(async (requestPath) => {
    const response = await fetch(requestPath);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${requestPath}`);
    }
    return response.json();
  }, path);
}

function encodeGeneratedFilePath(filePath: string): string {
  const segments = filePath.split("/");
  if (
    filePath.length === 0 ||
    filePath.startsWith("/") ||
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    throw new Error(`Invalid generated file path: ${filePath}`);
  }
  return segments.map(encodeURIComponent).join("/");
}

async function waitForRunProgress(
  page: Page,
  runId: string,
  expectedSteps: string[],
): Promise<ProgressResponse> {
  const deadline = Date.now() + 120_000;
  let latestBody: unknown = null;

  while (Date.now() < deadline) {
    latestBody = await fetchJsonFromPage(
      page,
      `${BFF_BASE_URL}/api/v0/runs/${encodeURIComponent(runId)}/progress`,
    );
    const steps =
      typeof latestBody === "object" &&
      latestBody !== null &&
      "steps" in latestBody
        ? (latestBody as { steps?: unknown }).steps
        : undefined;
    const stepNames = Array.isArray(steps)
      ? steps.map((step: { name?: string }) => step.name).filter(Boolean)
      : [];
    if (expectedSteps.every((stepName) => stepNames.includes(stepName))) {
      return latestBody as ProgressResponse;
    }
    await page.waitForTimeout(1_000);
  }

  const latestSteps =
    typeof latestBody === "object" &&
    latestBody !== null &&
    "steps" in latestBody
      ? (latestBody as { steps?: Array<{ name: string }> }).steps
      : undefined;
  expect(latestSteps?.map((step) => step.name) ?? []).toEqual(
    expect.arrayContaining(expectedSteps),
  );
  return latestBody as ProgressResponse;
}

test.describe("c2c Studio browser acceptance", () => {
  test("completes the deterministic W0 product path through browser-visible artifacts", async ({
    page,
  }) => {
    await expectReadyWorkbench(page);
    await enterProductPathCobol(page);

    const transformResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith("/api/v0/transform") &&
        response.status() === 201,
      { timeout: 120_000 },
    );

    await topBarStartButton(page).click();

    const transformResponse = await transformResponsePromise;
    const transformRequestBody = transformResponse.request().postDataJSON();
    expect(transformRequestBody).toEqual(
      expect.objectContaining({
        sourceText: PRODUCT_PATH_COBOL,
      }),
    );
    const transformBody = await transformResponse.json();
    expect(transformBody.runId).toBeTruthy();
    const runId = String(transformBody.runId);

    const [
      generatedBody,
      generatedFilesBody,
      buildTestBody,
      evidenceBody,
      experienceBody,
      artifactsBody,
    ] = await Promise.all([
      waitForJsonResponse(
        page,
        (response) =>
          response.url().endsWith(`/api/v0/runs/${runId}/generated`) &&
          response.ok(),
      ),
      waitForJsonResponse(
        page,
        (response) =>
          response.url().endsWith(`/api/v0/runs/${runId}/generated/files`) &&
          response.ok(),
      ),
      waitForJsonResponse(
        page,
        (response) =>
          response.url().endsWith(`/api/v0/runs/${runId}/build-test`) &&
          response.ok(),
      ),
      waitForJsonResponse(
        page,
        (response) =>
          response.url().endsWith(`/api/v0/runs/${runId}/evidence`) &&
          response.ok(),
      ),
      waitForJsonResponse(
        page,
        (response) =>
          response.url().endsWith(`/api/v0/runs/${runId}/experience`) &&
          response.ok(),
      ),
      waitForJsonResponse(
        page,
        (response) =>
          response.url().endsWith(`/api/v0/runs/${runId}/artifacts`) &&
          response.ok(),
      ),
    ]);
    const expectedProgressSteps = [
      "accepted",
      "parse-cobol",
      "generate-ir",
      "generate-java",
      "compile-test-java",
      "write-evidence",
      "completed",
    ];
    if (EXPECT_MODEL_POLICY_SKIPPED) {
      expectedProgressSteps.splice(5, 0, "model-policy-skipped");
    }
    const progressBody = await waitForRunProgress(
      page,
      runId,
      expectedProgressSteps,
    );

    expect(generatedBody.runId).toBe(runId);
    expect(generatedFilesBody.runId).toBe(runId);
    expect(buildTestBody.runId).toBe(runId);
    expect(evidenceBody.runId).toBe(runId);
    expect(progressBody.runId).toBe(runId);
    expect(experienceBody.runId).toBe(runId);
    expect(artifactsBody.runId).toBe(runId);

    expect(generatedBody.status).toBe("generated");
    expect(generatedFilesBody.status).toBe("complete");
    expect(buildTestBody.status).toBe("ok");
    expect(evidenceBody.status).toBe("complete");
    expect(progressBody.status).toBe("complete");
    expect(Array.isArray(artifactsBody.artifacts)).toBeTruthy();
    expect(artifactsBody.artifacts.length).toBeGreaterThan(0);
    expect(
      progressBody.steps.map((step: { name: string }) => step.name),
    ).toEqual(expect.arrayContaining(expectedProgressSteps));
    if (EXPECT_MODEL_POLICY_SKIPPED) {
      expect(progressBody.steps).toContainEqual(
        expect.objectContaining({
          name: "model-policy-skipped",
          status: "skipped",
        }),
      );
      expect(artifactsBody.artifacts).toContainEqual(
        expect.objectContaining({
          kind: "model-policy-skipped",
          name: "model-policy-skipped.json",
        }),
      );
    }

    const generatedFiles = generatedFilesBody as GeneratedFilesResponse;
    const entryFilePath =
      generatedFiles.entryFilePath ?? generatedFiles.files[0]?.path;
    expect(entryFilePath).toBeTruthy();
    const entryFile = generatedFiles.files.find(
      (file) => file.path === entryFilePath,
    );
    expect(entryFile).toBeTruthy();

    const generatedFileBody = (await fetchJsonFromPage(
      page,
      `${BFF_BASE_URL}/api/v0/runs/${encodeURIComponent(runId)}/generated/files/${encodeGeneratedFilePath(String(entryFilePath))}`,
    )) as GeneratedFileContentResponse;
    expect(generatedFileBody.runId).toBe(runId);
    expect(generatedFileBody.path).toBe(entryFilePath);
    expect(generatedFileBody.content).toContain("public");
    expect(generatedFileBody.sha256).toBe(entryFile?.sha256);

    const generatedArtifactSha = generatedBody.artifactRef?.sha256;
    expect(generatedArtifactSha).toBeTruthy();
    expect(generatedFilesBody.artifactRef?.sha256).toBe(generatedArtifactSha);
    expect(buildTestBody.generatedArtifactRef?.sha256).toBe(
      generatedArtifactSha,
    );
    expect(evidenceBody.generatedArtifactRef?.sha256).toBe(
      generatedArtifactSha,
    );

    const generatedJavaPane = page.getByTestId("generated-java-editor-surface");
    await expect(generatedJavaPane).toBeVisible();
    await expect(generatedJavaPane.locator(".monaco-editor")).toBeVisible();
    await expect(generatedJavaPane).toHaveAttribute(
      "data-file-path",
      String(entryFilePath),
    );
    await expect(generatedJavaPane).toHaveAttribute(
      "data-file-sha256",
      generatedFileBody.sha256,
    );
    await expect(generatedJavaPane).toHaveAttribute(
      "data-artifact-sha256",
      String(generatedArtifactSha),
    );
    const generatedClass = generatedFileBody.content.match(
      /\bpublic\s+(?:final\s+)?class\s+([A-Za-z_$][\w$]*)/,
    );
    const generatedClassName = generatedClass?.[1];
    expect(generatedClassName).toBeTruthy();
    await expect(generatedJavaPane).toContainText(
      new RegExp(`class\\s+${generatedClassName}`),
    );
    await expect(page.getByText("Verified", { exact: true })).toBeVisible();

    // Issue #173: live success path must surface the W0.2 workflow contract.
    // We fetch /workflow directly to assert the contract shape, then verify
    // the Agent tab renders without a failure verdict.
    const workflowBody = (await fetchJsonFromPage(
      page,
      `${BFF_BASE_URL}/api/v0/runs/${encodeURIComponent(runId)}/workflow`,
    )) as {
      runId: string;
      finalClassification: string | null;
      failureCode: string | null;
      repairAttempts: unknown[];
    };
    expect(workflowBody.runId).toBe(runId);
    expect(workflowBody.failureCode).toBeNull();
    expect(
      workflowBody.finalClassification === null ||
        workflowBody.finalClassification === "success",
    ).toBe(true);
    expect(Array.isArray(workflowBody.repairAttempts)).toBe(true);

    await page.getByRole("tab", { name: "Agent" }).click();
    const agentPanelHappy = page.getByTestId("agent-activity-panel");
    await expect(agentPanelHappy).toBeVisible();
    await expect(
      agentPanelHappy.getByTestId("agent-activity-final-failure"),
    ).toHaveCount(0);

    await page.getByRole("tab", { name: "Build & Test" }).click();
    await expect(page.getByText("Pipeline Stages")).toBeVisible();
    await expect(page.getByText("Parse COBOL")).toBeVisible();
    await expect(page.getByText("Generate Java")).toBeVisible();
    if (EXPECT_MODEL_POLICY_SKIPPED) {
      await expect(page.getByText("Model Policy Skipped")).toBeVisible();
    }
    await expect(page.getByText("Equivalence Analysis")).toBeVisible();

    await page.getByRole("tab", { name: "Experience Learning" }).click();
    await expect(page.getByText("Experience Learning Summary")).toBeVisible();

    await page.getByRole("tab", { name: "Evidence Pack" }).click();
    await expect(
      page.getByRole("heading", { name: /Evidence Pack Complete/i }),
    ).toBeVisible();
    await expect(
      page.getByText(
        "Displayed Java, build/test, and evidence all reference the same generated artifact.",
      ),
    ).toBeVisible();

    await page.getByRole("tab", { name: "Artifacts" }).click();
    await expect(page.getByText("Run Artifacts")).toBeVisible();
    await expect(page.getByRole("table")).toBeVisible();
  });

  test("shows blocked readiness and disables start when the BFF is unavailable", async ({
    page,
  }) => {
    await page.route("**/api/v0/health", async (route) => {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "BFF unavailable" }),
      });
    });

    await page.goto("/");

    await expect(page.getByTestId("studio-workbench-shell")).toBeVisible();
    await expect(page.getByLabel("Product readiness")).toContainText("Blocked");
    await expect(topBarStartButton(page)).toBeDisabled();
    await expect(page.getByLabel("Status Bar")).toContainText("Blocked");
  });

  test("surfaces unsupported-source results without marking the run verified", async ({
    page,
  }) => {
    const runId = "run-unsupported-browser";

    await page.route("**/api/v0/transform", async (route) => {
      if (route.request().method() === "OPTIONS") {
        await route.fulfill({
          status: 204,
          headers: MOCK_CORS_HEADERS,
        });
        return;
      }
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        headers: MOCK_CORS_HEADERS,
        body: JSON.stringify({
          runId,
          orchestratorRunId: runId,
          programId: "UNSUPPORTED01",
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
          programId: "UNSUPPORTED01",
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
          programId: "UNSUPPORTED01",
          mode: "live",
          productMode: "live",
          status: "unsupported",
          unsupportedFeatures: ["COPY REPLACING"],
          note: "Unsupported COBOL constructs block this run.",
          artifactRef: null,
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
            programId: "UNSUPPORTED01",
            mode: "live",
            productMode: "live",
            status: "complete",
            files: [],
            fileCount: 0,
            artifactRef: null,
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
          programId: "UNSUPPORTED01",
          mode: "live",
          productMode: "live",
          status: "skipped",
          classification: "skipped-no-execution",
          generatedArtifactRef: null,
          note: "Build/test skipped because the source is unsupported.",
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
          programId: "UNSUPPORTED01",
          mode: "live",
          productMode: "live",
          status: "incomplete",
          generatedArtifactRef: null,
          missingArtifacts: ["generatedJava"],
          note: "Evidence is incomplete because generated Java was never produced.",
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
          programId: "UNSUPPORTED01",
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
          programId: "UNSUPPORTED01",
          mode: "live",
          productMode: "live",
          summary: "No experience summary for unsupported fixture.",
        }),
      });
    });

    await page.route(`**/api/v0/runs/${runId}/artifacts`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          runId,
          programId: "UNSUPPORTED01",
          mode: "live",
          productMode: "live",
          artifacts: [],
          missingArtifacts: ["generatedJava"],
        }),
      });
    });

    await expectReadyWorkbench(page);
    await enterCobolSource(page, `       IDENTIFICATION DIVISION.
       PROGRAM-ID. UNSUPPORTED01.
       PROCEDURE DIVISION.
           COPY TESTLIB REPLACING ==X== BY ==Y==.
           STOP RUN.`);

    await topBarStartButton(page).click();

    await expect(
      page
        .getByRole("region", { name: "Generated Java" })
        .getByText("Unsupported COBOL constructs block this run."),
    ).toBeVisible();
    await expect(
      page.getByLabel(/COBOL Source/i).getByText("COPY REPLACING"),
    ).toBeVisible();
    await expect(page.getByText("Verified", { exact: true })).toHaveCount(0);
  });

  test("keeps generated Java visible when evidence is incomplete and blocks verification", async ({
    page,
  }) => {
    const runId = "run-evidence-incomplete-browser";
    const artifactSha = "123abc";
    const generatedJava = [
      "public class EvidenceGate {",
      "  public static void main(String[] args) {",
      '    System.out.println("evidence");',
      "  }",
      "}",
    ].join("\n");

    await page.route("**/api/v0/transform", async (route) => {
      if (route.request().method() === "OPTIONS") {
        await route.fulfill({
          status: 204,
          headers: MOCK_CORS_HEADERS,
        });
        return;
      }
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        headers: MOCK_CORS_HEADERS,
        body: JSON.stringify({
          runId,
          orchestratorRunId: runId,
          programId: "EVIDENCE01",
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
          programId: "EVIDENCE01",
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
          programId: "EVIDENCE01",
          mode: "live",
          productMode: "live",
          status: "generated",
          entryClass: "EvidenceGate",
          entryFilePath: "src/main/java/EvidenceGate.java",
          fileCount: 1,
          files: {},
          fileRefs: [
            {
              path: "src/main/java/EvidenceGate.java",
              sha256: artifactSha,
              byteSize: generatedJava.length,
            },
          ],
          artifactRef: {
            sha256: artifactSha,
            byteSize: generatedJava.length,
          },
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
            programId: "EVIDENCE01",
            mode: "live",
            productMode: "live",
            status: "complete",
            files: [
              {
                path: "src/main/java/EvidenceGate.java",
                sha256: artifactSha,
                byteSize: generatedJava.length,
                mimeType: "text/x-java-source",
              },
            ],
            fileCount: 1,
            entryFilePath: "src/main/java/EvidenceGate.java",
            artifactRef: {
              sha256: artifactSha,
              byteSize: generatedJava.length,
            },
          }),
        });
      },
    );

    await page.route(
      `**/api/v0/runs/${runId}/generated/files/src/main/java/EvidenceGate.java`,
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          headers: MOCK_CORS_HEADERS,
          body: JSON.stringify({
            runId,
            programId: "EVIDENCE01",
            mode: "live",
            productMode: "live",
            path: "src/main/java/EvidenceGate.java",
            content: generatedJava,
            sha256: artifactSha,
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
          programId: "EVIDENCE01",
          mode: "live",
          productMode: "live",
          status: "ok",
          classification: "match",
          generatedArtifactRef: {
            sha256: artifactSha,
          },
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
          programId: "EVIDENCE01",
          mode: "live",
          productMode: "live",
          status: "incomplete",
          packId: "pack-evidence01",
          manifestHash: "evidence-manifest-sha",
          generatedArtifactRef: {
            sha256: artifactSha,
          },
          missingArtifacts: ["harnessEvents"],
          note: "Evidence pack is missing required harness event artifacts.",
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
          programId: "EVIDENCE01",
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
          programId: "EVIDENCE01",
          mode: "live",
          productMode: "live",
          summary: "No experience summary for evidence-incomplete fixture.",
        }),
      });
    });

    await page.route(`**/api/v0/runs/${runId}/artifacts`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          runId,
          programId: "EVIDENCE01",
          mode: "live",
          productMode: "live",
          artifacts: [
            {
              sha256: artifactSha,
              byteSize: generatedJava.length,
              mimeType: "text/x-java-source",
              kind: "generatedJava",
              createdBy: "target-java-generation-service",
              createdAt: "2026-05-15T00:00:00Z",
              path: "src/main/java/EvidenceGate.java",
              name: "EvidenceGate.java",
            },
          ],
          missingArtifacts: ["harnessEvents"],
        }),
      });
    });

    await expectReadyWorkbench(page);
    await enterCobolSource(page, `       IDENTIFICATION DIVISION.
       PROGRAM-ID. EVIDENCE01.
       PROCEDURE DIVISION.
           DISPLAY 'EVIDENCE'.
           STOP RUN.`);

    await topBarStartButton(page).click();

    await expect(
      page.getByTestId("generated-java-editor-surface"),
    ).toContainText("public class EvidenceGate");
    await expect(
      page.getByText("Evidence Incomplete", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(
        "Evidence pack is missing required harness event artifacts.",
      ),
    ).toBeVisible();
    await expect(page.getByText("Verified", { exact: true })).toHaveCount(0);

    await page.getByRole("tab", { name: "Evidence Pack" }).click();
    const evidencePanel = page.getByRole("tabpanel");
    await expect(
      evidencePanel.getByRole("heading", { name: /Evidence Pack Incomplete/i }),
    ).toBeVisible();
    await expect(
      evidencePanel.getByRole("listitem").filter({ hasText: "harnessEvents" }),
    ).toBeVisible();
  });

  test("blocks verified state when generated, build, and evidence artifact hashes diverge", async ({
    page,
  }) => {
    const runId = "run-hash-mismatch-browser";
    const generatedSha = "generated-artifact-sha";
    const buildSha = "build-artifact-sha";
    const evidenceSha = "evidence-artifact-sha";
    const entryFilePath = "src/main/java/MismatchGate.java";
    const generatedJava = [
      "public final class MismatchGate {",
      "  public static void main(String[] args) {",
      '    System.out.println("mismatch");',
      "  }",
      "}",
    ].join("\n");
    const runLinks = {
      self: `/api/v0/runs/${runId}`,
      generated: `/api/v0/runs/${runId}/generated`,
      generatedFiles: `/api/v0/runs/${runId}/generated/files`,
      buildTest: `/api/v0/runs/${runId}/build-test`,
      evidence: `/api/v0/runs/${runId}/evidence`,
      events: `/api/v0/runs/${runId}/events`,
      artifacts: `/api/v0/runs/${runId}/artifacts`,
      progress: `/api/v0/runs/${runId}/progress`,
      learning: `/api/v0/runs/${runId}/learning`,
    };

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
          programId: "MISMATCH01",
          status: "starting",
          mode: "live",
          productMode: "live",
          createdAt: "2026-05-15T00:00:00Z",
          updatedAt: "2026-05-15T00:00:00Z",
          links: runLinks,
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
          programId: "MISMATCH01",
          status: "completed",
          mode: "live",
          productMode: "live",
          createdAt: "2026-05-15T00:00:00Z",
          updatedAt: "2026-05-15T00:00:01Z",
          links: runLinks,
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
          programId: "MISMATCH01",
          mode: "live",
          productMode: "live",
          status: "generated",
          entryClass: "MismatchGate",
          entryFilePath,
          fileCount: 1,
          files: {},
          fileRefs: [
            {
              path: entryFilePath,
              sha256: "file-sha",
              byteSize: generatedJava.length,
            },
          ],
          artifactRef: {
            sha256: generatedSha,
            byteSize: generatedJava.length,
          },
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
            programId: "MISMATCH01",
            mode: "live",
            productMode: "live",
            status: "complete",
            files: [
              {
                path: entryFilePath,
                sha256: "file-sha",
                byteSize: generatedJava.length,
                mimeType: "text/x-java-source",
              },
            ],
            fileCount: 1,
            entryFilePath,
            artifactRef: {
              sha256: generatedSha,
              byteSize: generatedJava.length,
            },
          }),
        });
      },
    );

    await page.route(
      `**/api/v0/runs/${runId}/generated/files/${entryFilePath}`,
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          headers: MOCK_CORS_HEADERS,
          body: JSON.stringify({
            runId,
            programId: "MISMATCH01",
            mode: "live",
            productMode: "live",
            path: entryFilePath,
            content: generatedJava,
            sha256: "file-sha",
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
          programId: "MISMATCH01",
          mode: "live",
          productMode: "live",
          status: "ok",
          classification: "match",
          generatedArtifactRef: {
            sha256: buildSha,
          },
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
          programId: "MISMATCH01",
          mode: "live",
          productMode: "live",
          status: "complete",
          packId: "pack-mismatch01",
          manifestHash: "mismatch-manifest-sha",
          generatedArtifactRef: {
            sha256: evidenceSha,
          },
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
          programId: "MISMATCH01",
          mode: "live",
          productMode: "live",
          events: [],
        }),
      });
    });

    await page.route(`**/api/v0/runs/${runId}/progress`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: MOCK_CORS_HEADERS,
        body: JSON.stringify({
          runId,
          programId: "MISMATCH01",
          mode: "live",
          productMode: "live",
          status: "complete",
          runStatus: "completed",
          currentStep: null,
          failedStep: null,
          completedSteps: ["accepted", "completed"],
          stepCount: 2,
          steps: [
            {
              stepId: 1,
              name: "accepted",
              capabilityId: "orchestrator",
              service: "orchestrator",
              actor: "orchestrator",
              status: "ok",
            },
            {
              stepId: 2,
              name: "completed",
              capabilityId: "orchestrator",
              service: "orchestrator",
              actor: "orchestrator",
              status: "ok",
            },
          ],
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
          programId: "MISMATCH01",
          mode: "live",
          productMode: "live",
          summary: "Hash mismatch fixture.",
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
          programId: "MISMATCH01",
          mode: "live",
          productMode: "live",
          artifacts: [
            {
              sha256: generatedSha,
              byteSize: generatedJava.length,
              mimeType: "application/json",
              kind: "generated-project-manifest",
              createdBy: "target-java-generation-service",
              createdAt: "2026-05-15T00:00:00Z",
              path: "generated-project-manifest.json",
              name: "generated-project-manifest.json",
            },
          ],
        }),
      });
    });

    await expectReadyWorkbench(page);
    await enterCobolSource(page, `       IDENTIFICATION DIVISION.
       PROGRAM-ID. MISMATCH01.
       PROCEDURE DIVISION.
           DISPLAY 'MISMATCH'.
           STOP RUN.`);

    await topBarStartButton(page).click();

    await expect(
      page.getByTestId("generated-java-editor-surface"),
    ).toContainText("public final class MismatchGate");
    await expect(
      page.getByText("Artifact Mismatch", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Verified", { exact: true })).toHaveCount(0);
  });

  // Issue #173: W0.2 agent activity panel surfaces activeAgent, repair budget,
  // repair attempts, and the closed-set failure code returned by the BFF.
  test("renders W0.2 workflow contract in the Agent panel with closed-set failure code", async ({
    page,
  }) => {
    const runId = "run-agent-activity-browser";
    const runLinks = {
      self: `/api/v0/runs/${runId}`,
      generated: `/api/v0/runs/${runId}/generated`,
      generatedFiles: `/api/v0/runs/${runId}/generated/files`,
      buildTest: `/api/v0/runs/${runId}/build-test`,
      evidence: `/api/v0/runs/${runId}/evidence`,
      events: `/api/v0/runs/${runId}/events`,
      artifacts: `/api/v0/runs/${runId}/artifacts`,
      progress: `/api/v0/runs/${runId}/progress`,
      learning: `/api/v0/runs/${runId}/learning`,
      workflow: `/api/v0/runs/${runId}/workflow`,
    };

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
          programId: "AGENT01",
          status: "starting",
          mode: "live",
          productMode: "live",
          createdAt: "2026-05-16T00:00:00Z",
          updatedAt: "2026-05-16T00:00:00Z",
          activeStep: null,
          agentAttemptCount: 0,
          repairBudget: null,
          finalClassification: null,
          failureCode: null,
          failureMessage: null,
          links: runLinks,
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
          programId: "AGENT01",
          status: "failed",
          mode: "live",
          productMode: "live",
          createdAt: "2026-05-16T00:00:00Z",
          updatedAt: "2026-05-16T00:00:02Z",
          activeStep: "generate-java",
          agentAttemptCount: 2,
          repairBudget: { limit: 3, used: 2, remaining: 1 },
          finalClassification: "blocked",
          failureCode: "model_policy_denied",
          failureMessage: "policy gateway refused invocation",
          links: runLinks,
        }),
      });
    });

    const blockedGenerated = {
      runId,
      programId: "AGENT01",
      mode: "live",
      productMode: "live",
      status: "incomplete",
      missingArtifacts: ["generatedJava"],
      artifactRef: null,
      note: "Generation blocked by model policy denial.",
    };
    await page.route(`**/api/v0/runs/${runId}/generated`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: MOCK_CORS_HEADERS,
        body: JSON.stringify(blockedGenerated),
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
            programId: "AGENT01",
            mode: "live",
            productMode: "live",
            status: "incomplete",
            files: [],
            fileCount: 0,
            artifactRef: null,
            missingArtifacts: ["generatedJava"],
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
          programId: "AGENT01",
          mode: "live",
          productMode: "live",
          status: "skipped",
          classification: "skipped-no-execution",
          generatedArtifactRef: null,
          note: "Build skipped because generation was blocked.",
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
          programId: "AGENT01",
          mode: "live",
          productMode: "live",
          status: "incomplete",
          generatedArtifactRef: null,
          missingArtifacts: ["generatedJava"],
          note: "Evidence incomplete (no generated Java).",
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
          programId: "AGENT01",
          mode: "live",
          productMode: "live",
          events: [],
        }),
      });
    });

    await page.route(`**/api/v0/runs/${runId}/progress`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: MOCK_CORS_HEADERS,
        body: JSON.stringify({
          runId,
          programId: "AGENT01",
          mode: "live",
          productMode: "live",
          status: "incomplete",
          runStatus: "failed",
          currentStep: null,
          failedStep: "generate-java",
          completedSteps: ["accepted", "parse-cobol", "generate-ir"],
          stepCount: 4,
          steps: [],
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
          programId: "AGENT01",
          mode: "live",
          productMode: "live",
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
          programId: "AGENT01",
          mode: "live",
          productMode: "live",
          artifacts: [],
          missingArtifacts: ["generatedJava"],
        }),
      });
    });

    await page.route(`**/api/v0/runs/${runId}/workflow`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: MOCK_CORS_HEADERS,
        body: JSON.stringify({
          runId,
          programId: "AGENT01",
          mode: "live",
          productMode: "live",
          source: "live",
          state: "blocked_policy",
          activeStep: "generate-java",
          activeAgent: "verification_repair_agent",
          agentAttemptCount: 2,
          repairBudget: { limit: 3, used: 2, remaining: 1 },
          assistBudget: { limit: 1, used: 1, remaining: 0 },
          modelInvocationBudget: { limit: 6, used: 2, remaining: 4 },
          repairAttempts: [
            {
              attemptNumber: 1,
              repairDecision: "propose_candidate",
              failureCategory: "java_compile_failed",
              hasModelInvocation: true,
              hasRepairInput: true,
              hasJavaCandidate: true,
              rationale: "Adjusted accumulator semantics.",
            },
            {
              attemptNumber: 2,
              repairDecision: "refuse",
              failureCategory: "model_policy_denied",
              hasModelInvocation: false,
              hasRepairInput: true,
              hasJavaCandidate: false,
              rationale: "Policy gateway refused the candidate model.",
            },
          ],
          // Issue #218 (W0.3-7): the existing failure-path acceptance now
          // also asserts the AI-assisted assist-decision the gate would
          // have published before the run was blocked downstream.
          assistDecision: {
            outcome: "assist_required",
            reasonCode: "caller_explicit_opt_in",
            decidedAt: "2026-05-16T00:00:01Z",
            selectedAgentRole: "transformation_agent",
            affectedArtifactRefs: [],
            repairBudgetSnapshot: { limit: 3, used: 0, remaining: 3 },
            assistBudgetSnapshot: { limit: 1, used: 1, remaining: 0 },
            modelInvocationBudgetSnapshot: {
              limit: 6,
              used: 1,
              remaining: 5,
            },
            rationale: "Caller opted in.",
          },
          finalClassification: "blocked",
          failureCode: "model_policy_denied",
          failureMessage: "policy gateway refused invocation",
          generatedJavaRef: null,
          buildTestResultRef: null,
          evidencePackRef: null,
        }),
      });
    });

    await expectReadyWorkbench(page);
    await enterCobolSource(page, `       IDENTIFICATION DIVISION.
       PROGRAM-ID. AGENT01.
       PROCEDURE DIVISION.
           DISPLAY 'AGENT'.
           STOP RUN.`);

    await topBarStartButton(page).click();

    // Open the Agent tab in the bottom workbench.
    await page.getByRole("tab", { name: "Agent" }).click();

    const agentPanel = page.getByTestId("agent-activity-panel");
    await expect(agentPanel).toBeVisible();
    await expect(
      agentPanel.getByTestId("agent-activity-workflow-status"),
    ).toContainText("blocked_policy");
    await expect(
      agentPanel.getByTestId("agent-activity-workflow-status"),
    ).toContainText("1 invocation record observed");
    await expect(
      agentPanel.getByTestId("agent-activity-artifact-refs"),
    ).toContainText("Final Java");
    await expect(
      agentPanel.getByTestId("agent-activity-artifact-refs"),
    ).toContainText("not published");
    await expect(
      agentPanel.getByText("Verification & Repair Agent"),
    ).toBeVisible();
    const attempt1 = agentPanel.getByTestId("agent-activity-repair-attempt-1");
    const attempt2 = agentPanel.getByTestId("agent-activity-repair-attempt-2");
    await expect(attempt1).toContainText("Attempt #1");
    await expect(attempt1).toContainText("Proposed candidate");
    await expect(attempt2).toContainText("Attempt #2");
    await expect(attempt2).toContainText("Refused");
    await expect(
      agentPanel.getByTestId("agent-activity-repair-budget"),
    ).toContainText("2 / 3 attempts used");

    const failure = agentPanel.getByTestId("agent-activity-final-failure");
    await expect(failure).toContainText("Model invocation denied by policy");

    // Status bar surfaces the closed-set failure code.
    await expect(page.getByTestId("status-bar-failure-code")).toHaveText(
      /model_policy_denied/,
    );

    // No success badge for a blocked run.
    await expect(page.getByTestId("status-bar-success-badge")).toHaveCount(0);

    // Issue #218 (W0.3-7): the assist-decision row must surface as
    // AI-assisted because the orchestrator fired the assist gate before
    // the policy denial blocked the run downstream.
    const assistDecision = agentPanel.getByTestId(
      "agent-activity-assist-decision",
    );
    await expect(assistDecision).toHaveAttribute(
      "data-assist-mode",
      "ai-assisted",
    );
    await expect(
      agentPanel.getByTestId("agent-activity-assist-mode-badge"),
    ).toContainText("AI-assisted run");
    await expect(
      agentPanel.getByTestId("agent-activity-assist-agent-role"),
    ).toContainText("Transformation Agent");

    await page.getByRole("tab", { name: "Artifacts" }).click();
    await expect(page.getByText("Missing artifact records")).toBeVisible();
    await expect(page.getByText("generatedJava")).toBeVisible();
  });

  test("@visual captures the main workbench desktop baseline", async ({
    page,
    browserName,
  }) => {
    test.skip(
      browserName !== "chromium",
      "Visual baseline is maintained only for Chromium.",
    );
    test.skip(
      process.platform !== "darwin",
      "Visual baseline is pinned from the primary local macOS environment.",
    );

    await expectReadyWorkbench(page);
    await enterProductPathCobol(page);
    await page.waitForLoadState("networkidle");

    await expect(page).toHaveScreenshot("workbench-desktop.png", {
      fullPage: true,
      animations: "disabled",
      caret: "hide",
      maxDiffPixelRatio: 0.01,
    });
  });
});
