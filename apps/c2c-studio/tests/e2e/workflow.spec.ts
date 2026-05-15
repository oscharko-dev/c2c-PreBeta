import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page, type Response } from '@playwright/test';

const COBOL_EDITOR_LABEL = /COBOL source editor/i;
const GENERATED_JAVA_LABEL = /Generated Java source for/i;
const PRODUCT_PATH_COBOL = readFileSync(
  path.resolve(__dirname, '../../../../corpus/synthetic/programs/branch-account-guard.cbl'),
  'utf8',
);
const BFF_BASE_URL = process.env.NEXT_PUBLIC_C2C_BFF_BASE_URL || 'http://127.0.0.1:18089';
const MOCK_CORS_HEADERS = {
  'access-control-allow-origin': 'http://127.0.0.1:3000',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'Content-Type',
};
interface ProgressResponse {
  runId?: string;
  status?: string;
  steps: Array<{ name: string; status?: string }>;
}

async function expectReadyWorkbench(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('application', { name: 'c2c Studio Workbench' })).toBeVisible();
  await expect(page.getByLabel('Product readiness')).toContainText('Ready');
}

function topBarStartButton(page: Page) {
  return page.getByLabel('Workbench Top Bar').getByRole('button', { name: 'Start Transformation' });
}

async function enterProductPathCobol(page: Page) {
  await page.getByRole('button', { name: 'Start Typing' }).click();

  const editor = page.getByRole('textbox', { name: COBOL_EDITOR_LABEL });
  await editor.fill(PRODUCT_PATH_COBOL);
  await expect(editor).toHaveValue(/PROGRAM-ID\. BRNCH01\./);
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
  return page.evaluate(async requestPath => {
    const response = await fetch(requestPath);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${requestPath}`);
    }
    return response.json();
  }, path);
}

async function waitForRunProgress(page: Page, runId: string, expectedSteps: string[]): Promise<ProgressResponse> {
  const deadline = Date.now() + 120_000;
  let latestBody: unknown = null;

  while (Date.now() < deadline) {
    latestBody = await fetchJsonFromPage(page, `${BFF_BASE_URL}/api/v0/runs/${encodeURIComponent(runId)}/progress`);
    const steps = typeof latestBody === 'object' && latestBody !== null && 'steps' in latestBody
      ? (latestBody as { steps?: unknown }).steps
      : undefined;
    const stepNames = Array.isArray(steps)
      ? steps.map((step: { name?: string }) => step.name).filter(Boolean)
      : [];
    if (expectedSteps.every(stepName => stepNames.includes(stepName))) {
      return latestBody as ProgressResponse;
    }
    await page.waitForTimeout(1_000);
  }

  const latestSteps = typeof latestBody === 'object' && latestBody !== null && 'steps' in latestBody
    ? (latestBody as { steps?: Array<{ name: string }> }).steps
    : undefined;
  expect(latestSteps?.map((step) => step.name) ?? []).toEqual(
    expect.arrayContaining(expectedSteps),
  );
  return latestBody as ProgressResponse;
}

test.describe('c2c Studio browser acceptance', () => {
  test('completes the deterministic W0 product path through browser-visible artifacts', async ({ page }) => {
    await expectReadyWorkbench(page);
    await enterProductPathCobol(page);

    const transformResponsePromise = page.waitForResponse(
      response =>
        response.request().method() === 'POST' &&
        response.url().endsWith('/api/v0/transform') &&
        response.status() === 201,
      { timeout: 120_000 },
    );

    await topBarStartButton(page).click();

    const transformResponse = await transformResponsePromise;
    const transformBody = await transformResponse.json();
    expect(transformBody.runId).toBeTruthy();
    const runId = String(transformBody.runId);

    const [generatedBody, generatedFilesBody, buildTestBody, evidenceBody, experienceBody, artifactsBody] = await Promise.all([
      waitForJsonResponse(
        page,
        response => response.url().endsWith(`/api/v0/runs/${runId}/generated`) && response.ok(),
      ),
      waitForJsonResponse(
        page,
        response => response.url().endsWith(`/api/v0/runs/${runId}/generated/files`) && response.ok(),
      ),
      waitForJsonResponse(
        page,
        response => response.url().endsWith(`/api/v0/runs/${runId}/build-test`) && response.ok(),
      ),
      waitForJsonResponse(
        page,
        response => response.url().endsWith(`/api/v0/runs/${runId}/evidence`) && response.ok(),
      ),
      waitForJsonResponse(
        page,
        response => response.url().endsWith(`/api/v0/runs/${runId}/experience`) && response.ok(),
      ),
      waitForJsonResponse(
        page,
        response => response.url().endsWith(`/api/v0/runs/${runId}/artifacts`) && response.ok(),
      ),
    ]);
    const expectedProgressSteps = [
      'accepted',
      'parse-cobol',
      'generate-ir',
      'generate-java',
      'compile-test-java',
      'model-policy-skipped',
      'write-evidence',
      'completed',
    ];
    const progressBody = await waitForRunProgress(page, runId, expectedProgressSteps);

    expect(generatedBody.runId).toBe(runId);
    expect(generatedFilesBody.runId).toBe(runId);
    expect(buildTestBody.runId).toBe(runId);
    expect(evidenceBody.runId).toBe(runId);
    expect(progressBody.runId).toBe(runId);
    expect(experienceBody.runId).toBe(runId);
    expect(artifactsBody.runId).toBe(runId);

    expect(generatedBody.status).toBe('generated');
    expect(generatedFilesBody.status).toBe('complete');
    expect(buildTestBody.status).toBe('ok');
    expect(evidenceBody.status).toBe('complete');
    expect(progressBody.status).toBe('complete');
    expect(Array.isArray(artifactsBody.artifacts)).toBeTruthy();
    expect(artifactsBody.artifacts.length).toBeGreaterThan(0);
    expect(progressBody.steps.map((step: { name: string }) => step.name)).toEqual(
      expect.arrayContaining(expectedProgressSteps),
    );
    expect(progressBody.steps).toContainEqual(expect.objectContaining({
      name: 'model-policy-skipped',
      status: 'skipped',
    }));
    expect(artifactsBody.artifacts).toContainEqual(expect.objectContaining({
      kind: 'model-policy-skipped',
      name: 'model-policy-skipped.json',
    }));

    const generatedArtifactSha = generatedBody.artifactRef?.sha256;
    expect(generatedArtifactSha).toBeTruthy();
    expect(buildTestBody.generatedArtifactRef?.sha256).toBe(generatedArtifactSha);
    expect(evidenceBody.generatedArtifactRef?.sha256).toBe(generatedArtifactSha);

    const generatedJavaPane = page.getByLabel(GENERATED_JAVA_LABEL);
    await expect(generatedJavaPane).toBeVisible();
    await expect(generatedJavaPane).toContainText(/public\s+(final\s+)?class/i);
    await expect(page.getByText('Verified', { exact: true })).toBeVisible();

    await page.getByRole('tab', { name: 'Build & Test' }).click();
    await expect(page.getByText('Pipeline Stages')).toBeVisible();
    await expect(page.getByText('Parse COBOL')).toBeVisible();
    await expect(page.getByText('Generate Java')).toBeVisible();
    await expect(page.getByText('Model Policy Skipped')).toBeVisible();
    await expect(page.getByText('Equivalence Analysis')).toBeVisible();

    await page.getByRole('tab', { name: 'Experience Learning' }).click();
    await expect(page.getByText('Experience Learning Summary')).toBeVisible();

    await page.getByRole('tab', { name: 'Evidence Pack' }).click();
    await expect(page.getByRole('heading', { name: /Evidence Pack Complete/i })).toBeVisible();
    await expect(page.getByText('Displayed Java, build/test, and evidence all reference the same generated artifact.')).toBeVisible();

    await page.getByRole('tab', { name: 'Artifacts' }).click();
    await expect(page.getByText('Run Artifacts')).toBeVisible();
    await expect(page.getByRole('table')).toBeVisible();
  });

  test('shows blocked readiness and disables start when the BFF is unavailable', async ({ page }) => {
    await page.route('**/api/v0/health', async route => {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'BFF unavailable' }),
      });
    });

    await page.goto('/');

    await expect(page.getByRole('application', { name: 'c2c Studio Workbench' })).toBeVisible();
    await expect(page.getByLabel('Product readiness')).toContainText('Blocked');
    await expect(topBarStartButton(page)).toBeDisabled();
    await expect(page.getByLabel('Status Bar')).toContainText('Blocked');
  });

  test('surfaces unsupported-source results without marking the run verified', async ({ page }) => {
    const runId = 'run-unsupported-browser';

    await page.route('**/api/v0/transform', async route => {
      if (route.request().method() === 'OPTIONS') {
        await route.fulfill({
          status: 204,
          headers: MOCK_CORS_HEADERS,
        });
        return;
      }
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        headers: MOCK_CORS_HEADERS,
        body: JSON.stringify({
          runId,
          orchestratorRunId: runId,
          programId: 'UNSUPPORTED01',
          status: 'starting',
          mode: 'live',
          productMode: 'live',
          createdAt: '2026-05-15T00:00:00Z',
          updatedAt: '2026-05-15T00:00:00Z',
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

    await page.route(`**/api/v0/runs/${runId}`, async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: MOCK_CORS_HEADERS,
        body: JSON.stringify({
          runId,
          orchestratorRunId: runId,
          programId: 'UNSUPPORTED01',
          status: 'completed',
          mode: 'live',
          productMode: 'live',
          createdAt: '2026-05-15T00:00:00Z',
          updatedAt: '2026-05-15T00:00:01Z',
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

    await page.route(`**/api/v0/runs/${runId}/generated`, async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: MOCK_CORS_HEADERS,
        body: JSON.stringify({
          runId,
          programId: 'UNSUPPORTED01',
          mode: 'live',
          productMode: 'live',
          status: 'unsupported',
          unsupportedFeatures: ['COPY REPLACING'],
          note: 'Unsupported COBOL constructs block this run.',
          artifactRef: null,
        }),
      });
    });

    await page.route(`**/api/v0/runs/${runId}/generated/files`, async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: MOCK_CORS_HEADERS,
        body: JSON.stringify({
          runId,
          programId: 'UNSUPPORTED01',
          mode: 'live',
          productMode: 'live',
          status: 'complete',
          files: [],
          fileCount: 0,
          artifactRef: null,
        }),
      });
    });

    await page.route(`**/api/v0/runs/${runId}/build-test`, async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: MOCK_CORS_HEADERS,
        body: JSON.stringify({
          runId,
          programId: 'UNSUPPORTED01',
          mode: 'live',
          productMode: 'live',
          status: 'skipped',
          classification: 'skipped-no-execution',
          generatedArtifactRef: null,
          note: 'Build/test skipped because the source is unsupported.',
        }),
      });
    });

    await page.route(`**/api/v0/runs/${runId}/evidence`, async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: MOCK_CORS_HEADERS,
        body: JSON.stringify({
          runId,
          programId: 'UNSUPPORTED01',
          mode: 'live',
          productMode: 'live',
          status: 'incomplete',
          generatedArtifactRef: null,
          missingArtifacts: ['generatedJava'],
          note: 'Evidence is incomplete because generated Java was never produced.',
        }),
      });
    });

    await page.route(`**/api/v0/runs/${runId}/events`, async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: MOCK_CORS_HEADERS,
        body: JSON.stringify({
          runId,
          programId: 'UNSUPPORTED01',
          mode: 'live',
          productMode: 'live',
          events: [],
        }),
      });
    });

    await page.route(`**/api/v0/runs/${runId}/experience`, async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: MOCK_CORS_HEADERS,
        body: JSON.stringify({
          runId,
          programId: 'UNSUPPORTED01',
          mode: 'live',
          productMode: 'live',
          summary: 'No experience summary for unsupported fixture.',
        }),
      });
    });

    await page.route(`**/api/v0/runs/${runId}/artifacts`, async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          runId,
          programId: 'UNSUPPORTED01',
          mode: 'live',
          productMode: 'live',
          artifacts: [],
          missingArtifacts: ['generatedJava'],
        }),
      });
    });

    await expectReadyWorkbench(page);
    await page.getByRole('button', { name: 'Start Typing' }).click();

    const editor = page.getByRole('textbox', { name: COBOL_EDITOR_LABEL });
    await editor.fill(`       IDENTIFICATION DIVISION.
       PROGRAM-ID. UNSUPPORTED01.
       PROCEDURE DIVISION.
           COPY TESTLIB REPLACING ==X== BY ==Y==.
           STOP RUN.`);

    await topBarStartButton(page).click();

    await expect(page.getByRole('region', { name: 'Generated Java' }).getByText('Unsupported COBOL constructs block this run.')).toBeVisible();
    await expect(page.getByLabel(/COBOL Source/i).getByText('COPY REPLACING')).toBeVisible();
    await expect(page.getByText('Verified', { exact: true })).toHaveCount(0);
  });

  test('keeps generated Java visible when evidence is incomplete and blocks verification', async ({ page }) => {
    const runId = 'run-evidence-incomplete-browser';
    const artifactSha = '123abc';
    const generatedJava = [
      'public class EvidenceGate {',
      '  public static void main(String[] args) {',
      '    System.out.println("evidence");',
      '  }',
      '}',
    ].join('\n');

    await page.route('**/api/v0/transform', async route => {
      if (route.request().method() === 'OPTIONS') {
        await route.fulfill({
          status: 204,
          headers: MOCK_CORS_HEADERS,
        });
        return;
      }
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        headers: MOCK_CORS_HEADERS,
        body: JSON.stringify({
          runId,
          orchestratorRunId: runId,
          programId: 'EVIDENCE01',
          status: 'starting',
          mode: 'live',
          productMode: 'live',
          createdAt: '2026-05-15T00:00:00Z',
          updatedAt: '2026-05-15T00:00:00Z',
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

    await page.route(`**/api/v0/runs/${runId}`, async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: MOCK_CORS_HEADERS,
        body: JSON.stringify({
          runId,
          orchestratorRunId: runId,
          programId: 'EVIDENCE01',
          status: 'completed',
          mode: 'live',
          productMode: 'live',
          createdAt: '2026-05-15T00:00:00Z',
          updatedAt: '2026-05-15T00:00:01Z',
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

    await page.route(`**/api/v0/runs/${runId}/generated`, async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: MOCK_CORS_HEADERS,
        body: JSON.stringify({
          runId,
          programId: 'EVIDENCE01',
          mode: 'live',
          productMode: 'live',
          status: 'generated',
          entryClass: 'EvidenceGate',
          entryFilePath: 'src/main/java/EvidenceGate.java',
          fileCount: 1,
          files: {
            'src/main/java/EvidenceGate.java': generatedJava,
          },
          artifactRef: {
            uri: 'urn:c2c/generated/EVIDENCE01',
            sha256: artifactSha,
            byteSize: generatedJava.length,
          },
        }),
      });
    });

    await page.route(`**/api/v0/runs/${runId}/generated/files`, async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: MOCK_CORS_HEADERS,
        body: JSON.stringify({
          runId,
          programId: 'EVIDENCE01',
          mode: 'live',
          productMode: 'live',
          status: 'complete',
          files: [
            {
              path: 'src/main/java/EvidenceGate.java',
              sha256: artifactSha,
              byteSize: generatedJava.length,
              mimeType: 'text/x-java-source',
            },
          ],
          fileCount: 1,
          entryFilePath: 'src/main/java/EvidenceGate.java',
          artifactRef: {
            uri: 'urn:c2c/generated/EVIDENCE01',
            sha256: artifactSha,
            byteSize: generatedJava.length,
          },
        }),
      });
    });

    await page.route(`**/api/v0/runs/${runId}/build-test`, async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: MOCK_CORS_HEADERS,
        body: JSON.stringify({
          runId,
          programId: 'EVIDENCE01',
          mode: 'live',
          productMode: 'live',
          status: 'ok',
          classification: 'match',
          generatedArtifactRef: {
            uri: 'urn:c2c/generated/EVIDENCE01',
            sha256: artifactSha,
          },
        }),
      });
    });

    await page.route(`**/api/v0/runs/${runId}/evidence`, async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: MOCK_CORS_HEADERS,
        body: JSON.stringify({
          runId,
          programId: 'EVIDENCE01',
          mode: 'live',
          productMode: 'live',
          status: 'incomplete',
          packId: 'pack-evidence01',
          manifestUri: 'urn:c2c/evidence/EVIDENCE01',
          generatedArtifactRef: {
            uri: 'urn:c2c/generated/EVIDENCE01',
            sha256: artifactSha,
          },
          missingArtifacts: ['harnessEvents'],
          note: 'Evidence pack is missing required harness event artifacts.',
        }),
      });
    });

    await page.route(`**/api/v0/runs/${runId}/events`, async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: MOCK_CORS_HEADERS,
        body: JSON.stringify({
          runId,
          programId: 'EVIDENCE01',
          mode: 'live',
          productMode: 'live',
          events: [],
        }),
      });
    });

    await page.route(`**/api/v0/runs/${runId}/experience`, async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: MOCK_CORS_HEADERS,
        body: JSON.stringify({
          runId,
          programId: 'EVIDENCE01',
          mode: 'live',
          productMode: 'live',
          summary: 'No experience summary for evidence-incomplete fixture.',
        }),
      });
    });

    await page.route(`**/api/v0/runs/${runId}/artifacts`, async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          runId,
          programId: 'EVIDENCE01',
          mode: 'live',
          productMode: 'live',
          artifacts: [
            {
              uri: 'urn:c2c/generated/EVIDENCE01',
              sha256: artifactSha,
              byteSize: generatedJava.length,
              mimeType: 'text/x-java-source',
              kind: 'generatedJava',
              createdBy: 'target-java-generation-service',
              createdAt: '2026-05-15T00:00:00Z',
              runId,
              workflowId: 'wf-evidence01',
              path: 'src/main/java/EvidenceGate.java',
              name: 'EvidenceGate.java',
            },
          ],
          missingArtifacts: ['harnessEvents'],
        }),
      });
    });

    await expectReadyWorkbench(page);
    await page.getByRole('button', { name: 'Start Typing' }).click();

    const editor = page.getByRole('textbox', { name: COBOL_EDITOR_LABEL });
    await editor.fill(`       IDENTIFICATION DIVISION.
       PROGRAM-ID. EVIDENCE01.
       PROCEDURE DIVISION.
           DISPLAY 'EVIDENCE'.
           STOP RUN.`);

    await topBarStartButton(page).click();

    await expect(page.getByLabel(GENERATED_JAVA_LABEL)).toContainText('public class EvidenceGate');
    await expect(page.getByText('Evidence Incomplete', { exact: true })).toBeVisible();
    await expect(page.getByText('Evidence pack is missing required harness event artifacts.')).toBeVisible();
    await expect(page.getByText('Verified', { exact: true })).toHaveCount(0);

    await page.getByRole('tab', { name: 'Evidence Pack' }).click();
    const evidencePanel = page.getByRole('tabpanel');
    await expect(evidencePanel.getByRole('heading', { name: /Evidence Pack Incomplete/i })).toBeVisible();
    await expect(evidencePanel.getByRole('listitem').filter({ hasText: 'harnessEvents' })).toBeVisible();
  });

  test('@visual captures the main workbench desktop baseline', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'Visual baseline is maintained only for Chromium.');
    test.skip(process.platform !== 'darwin', 'Visual baseline is pinned from the primary local macOS environment.');

    await expectReadyWorkbench(page);
    await enterProductPathCobol(page);
    await page.waitForLoadState('networkidle');

    await expect(page).toHaveScreenshot('workbench-desktop.png', {
      fullPage: true,
      animations: 'disabled',
      caret: 'hide',
      maxDiffPixelRatio: 0.01,
    });
  });
});
