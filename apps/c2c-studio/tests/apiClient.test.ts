import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiClient, resolveApiBaseUrl } from "../src/lib/apiClient";

describe("resolveApiBaseUrl", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults to same-origin relative calls", () => {
    expect(resolveApiBaseUrl()).toEqual({ ok: true, data: "" });
  });

  it("accepts a localhost split-server override", () => {
    expect(resolveApiBaseUrl("http://localhost:18089")).toEqual({
      ok: true,
      data: "http://localhost:18089",
    });
  });

  it("rejects non-local overrides", () => {
    const result = resolveApiBaseUrl("https://api.example.com");
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({
      ok: false,
      details: { kind: "config" },
    });
  });

  it("rejects non-root paths, query strings, and hashes in the override URL", () => {
    const result = resolveApiBaseUrl("http://localhost:18089/api?x=1#frag");
    expect(result).toMatchObject({
      ok: false,
      details: { kind: "config" },
    });
  });

  it("rejects non-http schemes", () => {
    const result = resolveApiBaseUrl("ftp://localhost:18089");
    expect(result).toMatchObject({
      ok: false,
      details: { kind: "config" },
    });
  });
});

describe("apiClient", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    vi.unstubAllEnvs();
  });

  it("fetches health successfully with default same-origin relative path", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({ status: "ok" }),
    } as Response);

    const result = await apiClient.getHealth();

    expect(fetch).toHaveBeenCalledWith("/api/v0/health", undefined);
    expect(result).toEqual({ ok: true, data: { status: "ok" } });
  });

  it("uses NEXT_PUBLIC_C2C_BFF_BASE_URL when configured for local split-server development", async () => {
    vi.stubEnv("NEXT_PUBLIC_C2C_BFF_BASE_URL", "http://localhost:18089");
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({ status: "ok" }),
    } as Response);

    const result = await apiClient.getHealth();

    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:18089/api/v0/health",
      undefined,
    );
    expect(result).toEqual({ ok: true, data: { status: "ok" } });
  });

  it("fetches harness readiness through the BFF-relative path", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      text: async () =>
        JSON.stringify({ status: "ok", summary: "2 capabilities registered" }),
    } as Response);

    const result = await apiClient.getHarnessReady();

    expect(fetch).toHaveBeenCalledWith("/api/v0/harness/ready", undefined);
    expect(result).toEqual({
      ok: true,
      data: { status: "ok", summary: "2 capabilities registered" },
    });
  });

  it("fetches mode successfully and preserves explicit reachability fields", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      text: async () =>
        JSON.stringify({
          orchestrator: "live",
          evidence: "mock",
          service: "c2c-bff",
        }),
    } as Response);

    const result = await apiClient.getMode();

    expect(result).toEqual({
      ok: true,
      data: { orchestrator: "live", evidence: "mock", service: "c2c-bff" },
    });
  });

  it("fetches and saves immutable trust-case selection contracts", async () => {
    const trustCase = {
      trustCaseId: "HELLOW02-DEFAULT",
      version: "2026-05-21",
      catalogVersion: "2026-05-21",
      catalogHash: "0".repeat(64),
      configurationDigest: "1".repeat(64),
      programId: "HELLOW02",
      title: "HELLOW02 default",
      description: "Default trust case",
      defaultForProgram: true,
      sourceReferenceFixtureId: "HELLOW02",
      sourceReferenceMode: "reference-fixture",
      environmentProfileId: "generated-java-sandbox-v1",
      comparisonStrategy: "deterministic-output",
      comparisonPolicyVersion: "deterministic-output-v1",
      supportedSubset: ["DISPLAY"],
    };
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            schemaVersion: "v0",
            catalogVersion: "2026-05-21",
            catalogHash: "0".repeat(64),
            programId: "HELLOW02",
            defaultTrustCaseId: "HELLOW02-DEFAULT",
            savedTrustCaseId: null,
            trustCases: [trustCase],
          }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            programId: "HELLOW02",
            trustCaseId: "HELLOW02-DEFAULT",
            persisted: true,
            selected: trustCase,
          }),
      } as Response);

    const listed = await apiClient.getTrustCases("HELLOW02");
    const saved = await apiClient.saveTrustCasePreference(
      "HELLOW02",
      "HELLOW02-DEFAULT",
    );

    expect(listed).toEqual({
      ok: true,
      data: {
        schemaVersion: "v0",
        catalogVersion: "2026-05-21",
        catalogHash: "0".repeat(64),
        programId: "HELLOW02",
        defaultTrustCaseId: "HELLOW02-DEFAULT",
        savedTrustCaseId: null,
        trustCases: [trustCase],
      },
    });
    expect(saved).toEqual({
      ok: true,
      data: {
        programId: "HELLOW02",
        trustCaseId: "HELLOW02-DEFAULT",
        persisted: true,
        selected: trustCase,
      },
    });
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "/api/v0/trust-cases?programId=HELLOW02",
      { credentials: "include" },
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "/api/v0/session/trust-case-preference",
      {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          programId: "HELLOW02",
          trustCaseId: "HELLOW02-DEFAULT",
        }),
      },
    );
  });

  it("upserts an intentional divergence decision and preserves trust-summary refs", async () => {
    const request = {
      decisionId: null,
      rationale:
        "The generated Java intentionally diverges to preserve a governed edge case.",
      reviewer: "banking-reviewer",
      linkedEvidenceRefs: ["pack-123", "artifact://evidence"],
      affectedOutputs: ["src/main/java/com/demo/LoanProcessor.java"],
      supersedesPreviousDecision: true,
      invalidationNote: "Supersedes the prior comparison review for this run.",
      expiresAt: "2026-06-01T12:00:00.000Z",
    };
    const payload = {
      runId: "run-42",
      programId: "PROG-42",
      status: "updated",
      decision: {
        decisionId: "decision-42",
        decisionRef: {
          sha256: "d".repeat(64),
          byteSize: 9,
          kind: "intentional-divergence-decision",
        },
        runId: "run-42",
        programId: "PROG-42",
        reviewer: request.reviewer,
        rationale: request.rationale,
        linkedEvidenceRefs: request.linkedEvidenceRefs,
        affectedOutputs: request.affectedOutputs,
        supersedesPreviousDecision: true,
        invalidationNote: request.invalidationNote,
        expiresAt: request.expiresAt,
        invalidatedAt: null,
        createdAt: "2026-05-21T12:00:00.000Z",
        updatedAt: "2026-05-21T12:05:00.000Z",
      },
      trustSummary: {
        trustState: "intentional_divergence",
        repairStatus: "repair_verified",
        coverageStatus: "full",
        divergenceDisposition: "intentional",
        intentionalDivergenceDecisionRef: {
          sha256: "d".repeat(64),
          byteSize: 9,
          kind: "intentional-divergence-decision",
        },
        warningCodes: [],
        trustCase: {
          trustCaseId: "TC-42",
          version: "v1",
          catalogVersion: "2026.05",
          catalogHash: "c".repeat(64),
          configurationDigest: "cfg-42",
        },
        cobolResult: { status: "completed" },
        javaResult: { status: "completed" },
        comparisonResult: {
          status: "mismatched",
          mismatchClassification: "intentional-divergence",
          decisionRecordRef: null,
        },
        repair: { status: "repair_verified" },
        evidence: { status: "current" },
        summaryDerivedAt: "2026-05-21T12:05:00.000Z",
      },
    };

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify(payload),
    } as Response);

    const result = await apiClient.upsertIntentionalDivergenceDecision(
      "run-42",
      request,
    );

    expect(fetch).toHaveBeenCalledWith(
      "/api/v0/runs/run-42/intentional-divergence-decision",
      expect.objectContaining({
        method: "PUT",
        credentials: "include",
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.status).toBe("updated");
      expect(result.data.trustSummary?.trustState).toBe(
        "intentional_divergence",
      );
      expect(
        result.data.trustSummary?.intentionalDivergenceDecisionRef?.sha256,
      ).toBe("d".repeat(64));
    }
  });

  it("rejects malformed transform payloads that miss required links", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      text: async () =>
        JSON.stringify({
          runId: "run-1",
          orchestratorRunId: "orch-1",
          programId: "P1",
          status: "starting",
          mode: "live",
          productMode: "live",
          createdAt: "2026-05-15T10:00:00Z",
          updatedAt: "2026-05-15T10:00:01Z",
        }),
    } as Response);

    const result = await apiClient.transform({
      sourceText: "      IDENTIFICATION DIVISION.",
      programId: "P1",
      sourceName: "sample.cbl",
    });

    expect(result).toMatchObject({
      ok: false,
      details: { kind: "contract" },
    });
  });

  it("rejects malformed run payloads with invalid status values", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      text: async () =>
        JSON.stringify({
          runId: "run-1",
          programId: "P1",
          status: "running",
          mode: "live",
          productMode: "live",
          createdAt: "2026-05-15T10:00:00Z",
          updatedAt: "2026-05-15T10:00:01Z",
        }),
    } as Response);

    const result = await apiClient.getRun("run-1");

    expect(result).toMatchObject({
      ok: false,
      details: { kind: "contract" },
    });
  });

  it("accepts future-version run summaries with the per-file classification map", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      text: async () =>
        JSON.stringify({
          schemaVersion: "v1",
          runId: "run-1",
          programId: "P1",
          status: "completed",
          mode: "live",
          productMode: "live",
          createdAt: "2026-05-15T10:00:00Z",
          updatedAt: "2026-05-15T10:00:01Z",
          javaRegionClassification: {
            "src/main/java/P1.java": [
              {
                schemaVersion: "v1",
                lineRange: { startLine: 1, endLine: 3 },
                originClass: "deterministic",
                verificationOutcome: "oracle_passed",
                mappingClass: "direct",
              },
              {
                schemaVersion: "v2",
                lineRange: { startLine: 4, endLine: 5 },
                originClass: "future_origin",
                verificationOutcome: "oracle_passed",
                mappingClass: "direct",
              },
            ],
            constructor: [
              {
                schemaVersion: "v1",
                lineRange: { startLine: 1, endLine: 1 },
                originClass: "deterministic",
                verificationOutcome: "oracle_passed",
                mappingClass: "direct",
              },
            ],
          },
          futureField: { preserved: true },
        }),
    } as Response);

    const result = await apiClient.getRun("run-1");

    expect(result).toMatchObject({
      ok: true,
      data: {
        schemaVersion: "v1",
        javaRegionClassification: {
          "src/main/java/P1.java": [
            {
              schemaVersion: "v1",
              originClass: "deterministic",
            },
          ],
        },
        futureField: { preserved: true },
      },
    });
    if (result.ok) {
      expect(
        result.data.javaRegionClassification?.["src/main/java/P1.java"],
      ).toHaveLength(1);
      expect(result.data.javaRegionClassification).not.toHaveProperty(
        "constructor",
      );
    }
  });

  it("rejects malformed artifacts payloads with invalid artifact metadata", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      text: async () =>
        JSON.stringify({
          runId: "run-1",
          programId: "P1",
          mode: "live",
          productMode: "live",
          artifacts: [
            {
              sha256: "a".repeat(64),
              byteSize: -1,
              mimeType: "text/plain",
              kind: "source",
              createdBy: "orchestrator",
              createdAt: "2026-05-15T10:00:00Z",
              path: "source.cbl",
              name: "source.cbl",
            },
          ],
        }),
    } as Response);

    const result = await apiClient.getRunArtifacts("run-1");

    expect(result).toMatchObject({
      ok: false,
      details: { kind: "contract" },
    });
  });

  it("accepts evidence payloads that report invalid validation state", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      text: async () =>
        JSON.stringify({
          runId: "run-1",
          programId: "P1",
          mode: "live",
          productMode: "live",
          status: "invalid",
          generatedArtifactRef: { sha256: "a".repeat(64) },
        }),
    } as Response);

    const result = await apiClient.getEvidence("run-1");

    expect(result).toEqual({
      ok: true,
      data: {
        runId: "run-1",
        programId: "P1",
        mode: "live",
        productMode: "live",
        status: "invalid",
        generatedArtifactRef: { sha256: "a".repeat(64) },
      },
    });
  });

  it("exports parity evidence as a Java regression scaffold and parses the scaffold reference", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      text: async () =>
        JSON.stringify({
          runId: "run-1",
          programId: "P1",
          status: "created",
          message:
            "Java parity regression scaffold exported as a run artifact.",
          export: {
            exportId: "hello-regression",
            qualification: "clean",
            scaffoldRef: {
              sha256: "s".repeat(64),
              byteSize: 512,
              kind: "parity-regression-test-file",
              path: "exports/java-regression/p1/hello/src/test/java/P1ParityRegressionTest.java",
              createdAt: "2026-05-21T12:34:56.000Z",
            },
            projectRoot: "run-export-1",
            scaffoldTestPath: "src/test/java/P1ParityRegressionTest.java",
            projectManifestRef: {
              sha256: "p".repeat(64),
              byteSize: 128,
              kind: "parity-regression-project-manifest",
            },
            manifestRef: {
              sha256: "m".repeat(64),
              byteSize: 128,
              kind: "parity-regression-export-manifest",
            },
            expectedOutputRef: {
              sha256: "e".repeat(64),
              byteSize: 128,
              kind: "parity-regression-expected-output",
            },
            createdAt: "2026-05-21T12:34:56.000Z",
          },
        }),
    } as Response);

    const result = await apiClient.exportParityEvidenceScaffold("run-1", {
      exportName: "hello-regression",
    });

    expect(fetch).toHaveBeenCalledWith("/api/v0/runs/run-1/evidence/export", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ exportName: "hello-regression" }),
    });
    expect(result).toEqual({
      ok: true,
      data: {
        runId: "run-1",
        programId: "P1",
        status: "created",
        message: "Java parity regression scaffold exported as a run artifact.",
        export: {
          exportId: "hello-regression",
          qualification: "clean",
          scaffoldRef: {
            sha256: "s".repeat(64),
            byteSize: 512,
            kind: "parity-regression-test-file",
            path: "exports/java-regression/p1/hello/src/test/java/P1ParityRegressionTest.java",
            createdAt: "2026-05-21T12:34:56.000Z",
          },
          projectRoot: "run-export-1",
          scaffoldTestPath: "src/test/java/P1ParityRegressionTest.java",
          projectManifestRef: {
            sha256: "p".repeat(64),
            byteSize: 128,
            kind: "parity-regression-project-manifest",
          },
          manifestRef: {
            sha256: "m".repeat(64),
            byteSize: 128,
            kind: "parity-regression-export-manifest",
          },
          expectedOutputRef: {
            sha256: "e".repeat(64),
            byteSize: 128,
            kind: "parity-regression-expected-output",
          },
          createdAt: "2026-05-21T12:34:56.000Z",
        },
      },
    });
  });

  it("posts parity evidence export requests and validates the response shape", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      text: async () =>
        JSON.stringify({
          runId: "run-1",
          programId: "P1",
          status: "created",
          message: "Scaffold exported for review.",
          export: {
            exportId: "export-1",
            projectRoot: "runs/run-1/exports/java-regression/case01",
            scaffoldTestPath:
              "runs/run-1/exports/java-regression/case01/src/test/java/com/demo/CASE01ParityRegressionTest.java",
            scaffoldRef: {
              sha256: "s".repeat(64),
              byteSize: 256,
              kind: "parity-regression-test-file",
              path: "runs/run-1/exports/java-regression/case01/src/test/java/com/demo/CASE01ParityRegressionTest.java",
              createdAt: "2026-05-21T13:00:00.000Z",
              createdBy: "orchestrator-service",
            },
            projectManifestRef: null,
            manifestRef: null,
            expectedOutputRef: null,
            createdAt: "2026-05-21T13:00:00.000Z",
            qualification: "clean",
          },
        }),
    } as Response);

    const result = await apiClient.exportParityEvidenceScaffold("run-1", {
      exportName: "case01",
    });

    expect(fetch).toHaveBeenCalledWith("/api/v0/runs/run-1/evidence/export", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ exportName: "case01" }),
    });
    expect(result).toEqual({
      ok: true,
      data: {
        runId: "run-1",
        programId: "P1",
        status: "created",
        message: "Scaffold exported for review.",
        export: {
          exportId: "export-1",
          projectRoot: "runs/run-1/exports/java-regression/case01",
          scaffoldTestPath:
            "runs/run-1/exports/java-regression/case01/src/test/java/com/demo/CASE01ParityRegressionTest.java",
          scaffoldRef: {
            sha256: "s".repeat(64),
            byteSize: 256,
            kind: "parity-regression-test-file",
            path: "runs/run-1/exports/java-regression/case01/src/test/java/com/demo/CASE01ParityRegressionTest.java",
            createdAt: "2026-05-21T13:00:00.000Z",
            createdBy: "orchestrator-service",
          },
          projectManifestRef: null,
          manifestRef: null,
          expectedOutputRef: null,
          createdAt: "2026-05-21T13:00:00.000Z",
          qualification: "clean",
        },
      },
    });
  });

  it("accepts valid build-test payloads with object outputRef metadata", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      text: async () =>
        JSON.stringify({
          runId: "run-1",
          programId: "P1",
          mode: "live",
          productMode: "live",
          status: "ok",
          classification: "match",
          outputRef: {
            sha256: "b".repeat(64),
            byteSize: 256,
          },
          diagnostics: [
            {
              severity: "warning",
              code: "javac-deprecation",
              message: "uses a deprecated API",
              line: 12,
              column: 7,
              filePath: "src/main/java/P1.java",
              sourceKind: "generated_java",
            },
          ],
          generatedArtifactRef: {
            sha256: "a".repeat(64),
            byteSize: 128,
          },
        }),
    } as Response);

    const result = await apiClient.getBuildTest("run-1");

    expect(result).toEqual({
      ok: true,
      data: {
        runId: "run-1",
        programId: "P1",
        mode: "live",
        productMode: "live",
        status: "ok",
        classification: "match",
        outputRef: {
          sha256: "b".repeat(64),
          byteSize: 256,
        },
        diagnostics: [
          {
            severity: "warning",
            code: "javac-deprecation",
            message: "uses a deprecated API",
            line: 12,
            column: 7,
            filePath: "src/main/java/P1.java",
            sourceKind: "generated_java",
          },
        ],
        generatedArtifactRef: {
          sha256: "a".repeat(64),
          byteSize: 128,
        },
      },
    });
  });

  it("rejects malformed build-test payloads with invalid artifact metadata", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      text: async () =>
        JSON.stringify({
          runId: "run-1",
          programId: "P1",
          mode: "live",
          productMode: "live",
          status: "ok",
          classification: "match",
          generatedArtifactRef: {
            sha256: "a".repeat(64),
            byteSize: -1,
          },
        }),
    } as Response);

    const result = await apiClient.getBuildTest("run-1");

    expect(result).toMatchObject({
      ok: false,
      details: { kind: "contract" },
    });
  });

  it("parses manual compile repair preview contracts", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      text: async () =>
        JSON.stringify({
          schemaVersion: "v0",
          runId: "run-1",
          preview: {
            schemaVersion: "v0",
            previewId: "preview-1",
            runId: "run-1",
            workflowId: "w0-migration-v0",
            failureCategory: "oracle_mismatch",
            sourceRevisionRef: {
              sha256: "a".repeat(64),
              byteSize: 128,
            },
            currentHeadRef: {
              sha256: "b".repeat(64),
              byteSize: 128,
            },
            buildTestResultRef: {
              sha256: "c".repeat(64),
              byteSize: 128,
            },
            includedFiles: [
              {
                path: "src/main/java/P1.java",
                sha256: "d".repeat(64),
                byteSize: 64,
                role: "entry-file",
              },
            ],
            diagnostics: [
              {
                severity: "error",
                code: "cannot-find-symbol",
                message: "cannot find symbol",
                filePath: "src/main/java/P1.java",
                line: 7,
              },
            ],
            manualRegions: [
              {
                filePath: "src/main/java/P1.java",
                originClass: "manual_edit",
                startLine: 6,
                endLine: 7,
              },
            ],
            constraints: {
              reviewRequiredBeforeAgentStart: true,
            },
            exclusionSummary: {
              excludedJavaFileCount: 0,
              excludedDiagnosticCount: 0,
              redactionsApplied: true,
            },
          },
        }),
    } as Response);

    const result = await apiClient.manualCompileRepairPreview({
      runId: "run-1",
      entryFilePath: "src/main/java/P1.java",
      javaFiles: [
        {
          path: "src/main/java/P1.java",
          content: "public class P1 {}",
        },
      ],
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        schemaVersion: "v0",
        runId: "run-1",
        preview: {
          previewId: "preview-1",
          failureCategory: "oracle_mismatch",
        },
      },
    });
  });

  it("parses manual compile repair accept contracts", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      text: async () =>
        JSON.stringify({
          schemaVersion: "v0",
          runId: "run-1",
          proposal: {
            proposalId: "proposal-1",
            runId: "run-1",
            patchSha256: "e".repeat(64),
            applicationState: "applied",
            approvalState: "approved",
            files: [
              {
                path: "src/main/java/P1.java",
                changeType: "modify",
                afterSha256: "f".repeat(64),
              },
            ],
          },
          candidateProject: {
            entryClass: "P1",
            entryFilePath: "src/main/java/P1.java",
            files: {
              "src/main/java/P1.java": "public class P1 {}",
            },
          },
          buildTest: {
            runId: "run-1",
            programId: "P1",
            mode: "live",
            productMode: "live",
            status: "ok",
            classification: "match",
            generatedArtifactRef: null,
          },
        }),
    } as Response);

    const result = await apiClient.manualCompileRepairAccept({
      runId: "run-1",
      proposalId: "proposal-1",
      patchSha256: "e".repeat(64),
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        runId: "run-1",
        proposal: {
          proposalId: "proposal-1",
          approvalState: "approved",
        },
        candidateProject: {
          entryClass: "P1",
        },
        buildTest: {
          status: "ok",
          classification: "match",
        },
      },
    });
  });

  it("fetches generated view and generated file index contract payloads", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            runId: "run-1",
            programId: "P1",
            mode: "live",
            productMode: "live",
            status: "generated",
            entryClass: "P1",
            diagnostics: [
              {
                severity: "warning",
                code: "gen-open-assumption",
                message: "fallback path used",
                line: 4,
                originStep: "generate-java",
              },
            ],
            artifactRef: {
              sha256: "a".repeat(64),
              byteSize: 128,
              kind: "generated-project-manifest",
            },
          }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            runId: "run-1",
            programId: "P1",
            mode: "live",
            productMode: "live",
            status: "complete",
            entryFilePath: "src/main/java/P1.java",
            files: [
              {
                path: "src/main/java/P1.java",
                sha256: "b".repeat(64),
                byteSize: 512,
                mimeType: "text/x-java-source",
              },
            ],
            fileCount: 1,
            artifactRef: {
              sha256: "a".repeat(64),
              byteSize: 128,
              kind: "generated-project-manifest",
            },
          }),
      } as Response);

    const generated = await apiClient.getGenerated("run-1");
    const generatedFiles = await apiClient.getGeneratedFiles("run-1");

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "/api/v0/runs/run-1/generated",
      undefined,
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "/api/v0/runs/run-1/generated/files",
      undefined,
    );
    expect(generated).toMatchObject({
      ok: true,
      data: {
        status: "generated",
        artifactRef: { sha256: "a".repeat(64) },
        diagnostics: [
          {
            severity: "warning",
            code: "gen-open-assumption",
            message: "fallback path used",
            line: 4,
            originStep: "generate-java",
          },
        ],
      },
    });
    expect(generatedFiles).toMatchObject({
      ok: true,
      data: {
        status: "complete",
        entryFilePath: "src/main/java/P1.java",
        artifactRef: { sha256: "a".repeat(64) },
      },
    });
  });

  it("normalizes ADR-0006 null diagnostic fallbacks on generated views", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      text: async () =>
        JSON.stringify({
          runId: "run-1",
          programId: "P1",
          mode: "live",
          productMode: "live",
          status: "generated",
          artifactRef: null,
          traceability: {
            schemaVersion: "v1",
            programId: "P1",
            irId: "ir-P1",
            sourceHash: "source-hash",
          },
          diagnostics: [
            {
              schemaVersion: "v1",
              severity: "info",
              code: "legacy-location",
              message: "location unavailable",
              line: null,
              column: null,
              endLine: null,
              endColumn: null,
              filePath: null,
              sourceKind: null,
              originStep: null,
              artifactRef: null,
            },
          ],
        }),
    } as Response);

    const result = await apiClient.getGenerated("run-1");

    expect(result).toMatchObject({
      ok: true,
      data: {
        traceability: {
          schemaVersion: "v1",
          irId: "ir-P1",
        },
        diagnostics: [
          {
            schemaVersion: "v1",
            severity: "info",
            code: "legacy-location",
            message: "location unavailable",
            artifactRef: null,
          },
        ],
      },
    });
    if (result.ok) {
      expect(result.data.diagnostics?.[0]).not.toHaveProperty("line");
      expect(result.data.diagnostics?.[0]).not.toHaveProperty("filePath");
    }
  });

  it("accepts live run progress payloads from the BFF progress endpoint", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      text: async () =>
        JSON.stringify({
          runId: "run-1",
          programId: "BRNCH01",
          mode: "live",
          productMode: "live",
          status: "complete",
          runStatus: "completed",
          currentStep: null,
          failedStep: null,
          completedSteps: [
            "accepted",
            "parse-cobol",
            "generate-ir",
            "generate-java",
            "compile-test-java",
            "write-evidence",
          ],
          stepCount: 2,
          steps: [
            {
              stepId: 1,
              name: "accepted",
              capabilityId: "orchestrator-service",
              service: "orchestrator-service",
              actor: "orchestrator-service",
              status: "ok",
            },
            {
              stepId: 2,
              name: "model-policy-skipped",
              capabilityId: "orchestrator-service",
              service: "orchestrator-service",
              actor: "orchestrator-service",
              status: "skipped",
              diagnostic: "no modelPrompt provided by requester",
            },
          ],
          missingArtifacts: [],
          orchestratorRunId: "orch-1",
        }),
    } as Response);

    const result = await apiClient.getRunProgress("run-1");

    expect(fetch).toHaveBeenCalledWith(
      "/api/v0/runs/run-1/progress",
      undefined,
    );
    expect(result).toMatchObject({
      ok: true,
      data: {
        runId: "run-1",
        status: "complete",
        steps: [
          { name: "accepted", status: "ok" },
          { name: "model-policy-skipped", status: "skipped" },
        ],
      },
    });
  });

  it("rejects malformed build-test payloads with invalid classifications", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      text: async () =>
        JSON.stringify({
          runId: "run-1",
          programId: "P1",
          mode: "live",
          productMode: "live",
          status: "run-failed",
          classification: "definitely-not-a-valid-classification",
          generatedArtifactRef: {
            sha256: "a".repeat(64),
            byteSize: 128,
          },
        }),
    } as Response);

    const result = await apiClient.getBuildTest("run-1");

    expect(result).toMatchObject({
      ok: false,
      details: { kind: "contract" },
    });
  });

  it("fails on invalid runtime configuration instead of falling back to an internal service URL", async () => {
    vi.stubEnv("NEXT_PUBLIC_C2C_BFF_BASE_URL", "https://internal.example.net");

    const result = await apiClient.getHealth();

    expect(fetch).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: false,
      details: { kind: "config" },
    });
  });

  it("handles HTTP failures without converting them into success", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: async () => JSON.stringify({ error: "orchestrator unavailable" }),
    } as Response);

    const result = await apiClient.getHealth();

    expect(result).toEqual({
      ok: false,
      status: 503,
      message: "orchestrator unavailable",
      details: { kind: "http", body: { error: "orchestrator unavailable" } },
    });
  });

  it("handles network failures without converting them into success", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("Network failure"));

    const result = await apiClient.getHealth();

    expect(result).toMatchObject({
      ok: false,
      message: "Network failure",
      details: { kind: "network" },
    });
  });

  it("reports malformed JSON as a contract failure", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      text: async () => "{not-json",
    } as Response);

    const result = await apiClient.getHealth();

    expect(result).toMatchObject({
      ok: false,
      message: "Contract error: API returned malformed JSON.",
      details: { kind: "parse" },
    });
  });

  it("reports unexpected payload shapes as contract failures", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({ state: "ok" }),
    } as Response);

    const result = await apiClient.getHealth();

    expect(result).toMatchObject({
      ok: false,
      details: { kind: "contract", body: { state: "ok" } },
    });
  });

  it("rejects malformed generated file payloads that miss required metadata", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      text: async () =>
        JSON.stringify({
          path: "src/App.java",
          content: "public class App {}",
        }),
    } as Response);

    const result = await apiClient.getGeneratedFile("run-1", "src/App.java");

    expect(result).toMatchObject({
      ok: false,
      details: { kind: "contract" },
    });
  });

  it("rejects absolute and traversal generated file paths before fetch", async () => {
    expect(() => apiClient.getGeneratedFile("run-1", "/abs/App.java")).toThrow(
      "Generated file path must be a relative, normalized path.",
    );
    expect(() => apiClient.getGeneratedFile("run-1", "../App.java")).toThrow(
      "Generated file path must be a relative, normalized path.",
    );
    // Backslash guard: a path containing a backslash must be rejected regardless
    // of whether other segments look valid. Removing `filePath.includes("\\") ||`
    // from encodeGeneratedFilePath would allow these through and break this test.
    expect(() => apiClient.getGeneratedFile("run-1", "src\\App.java")).toThrow(
      "Generated file path must be a relative, normalized path.",
    );
    expect(() => apiClient.getGeneratedFile("run-1", "foo\\..\\bar")).toThrow(
      "Generated file path must be a relative, normalized path.",
    );

    expect(fetch).not.toHaveBeenCalled();
  });

  // Issue #173: contract round-trip for the W0.2 workflow view.
  it("fetches /workflow and accepts a valid RunWorkflowView payload", async () => {
    const payload = {
      runId: "run-1",
      programId: "PROG01",
      mode: "live",
      productMode: "live",
      source: "live",
      state: "agent_running",
      activeStep: "generate-java",
      activeAgent: "transformation_agent",
      agentAttemptCount: 1,
      repairBudget: { limit: 3, used: 1, remaining: 2 },
      assistBudget: { limit: 1, used: 1, remaining: 0 },
      modelInvocationBudget: { limit: 6, used: 2, remaining: 4 },
      repairAttempts: [
        {
          attemptNumber: 1,
          repairDecision: "propose_candidate",
          failureCategory: "oracle_mismatch",
          hasModelInvocation: true,
          hasRepairInput: true,
          hasJavaCandidate: true,
          rationale: "first repair attempt",
        },
      ],
      assistDecision: null,
      finalClassification: null,
      failureCode: null,
      failureMessage: null,
      generatedJavaRef: {
        sha256: "abc",
        byteSize: 100,
        kind: "generated-project-manifest",
      },
      buildTestResultRef: null,
      evidencePackRef: null,
    };
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify(payload),
    } as Response);

    const result = await apiClient.getRunWorkflow("run-1");

    expect(fetch).toHaveBeenCalledWith(
      "/api/v0/runs/run-1/workflow",
      undefined,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.activeAgent).toBe("transformation_agent");
      expect(result.data.repairAttempts).toHaveLength(1);
      expect(result.data.repairBudget?.remaining).toBe(2);
      expect(result.data.assistDecision).toBeNull();
    }
  });

  it("rejects unknown W02 failure codes from /workflow", async () => {
    const payload = {
      runId: "run-2",
      programId: "P",
      mode: "live",
      productMode: "live",
      source: "live",
      state: null,
      activeStep: null,
      activeAgent: null,
      agentAttemptCount: 0,
      repairBudget: null,
      assistBudget: null,
      modelInvocationBudget: null,
      repairAttempts: [],
      assistDecision: null,
      finalClassification: "failed",
      failureCode: "totally_unknown_code",
      failureMessage: "nope",
      generatedJavaRef: null,
      buildTestResultRef: null,
      evidencePackRef: null,
    };
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify(payload),
    } as Response);

    const result = await apiClient.getRunWorkflow("run-2");
    expect(result).toMatchObject({ ok: false, details: { kind: "contract" } });
  });

  // Issue #218 (W0.3-7): the Studio rejects assist-decision payloads
  // with unknown closed-set values or invariant violations so an upstream
  // regression cannot be silently mis-rendered.
  it("accepts an assist-required assist-decision payload on /workflow", async () => {
    const payload = {
      runId: "run-assist-1",
      programId: "P",
      mode: "live",
      productMode: "live",
      source: "live",
      state: "assist_decision_recorded",
      activeStep: "assist-decision-gate",
      activeAgent: "transformation_agent",
      agentAttemptCount: 0,
      repairBudget: { limit: 3, used: 0, remaining: 3 },
      assistBudget: { limit: 1, used: 1, remaining: 0 },
      modelInvocationBudget: { limit: 6, used: 1, remaining: 5 },
      repairAttempts: [],
      assistDecision: {
        outcome: "assist_required",
        reasonCode: "semantic_ir_bounded_ambiguity",
        decidedAt: "2026-05-17T12:00:00Z",
        selectedAgentRole: "transformation_agent",
        affectedArtifactRefs: [
          {
            sha256: "a".repeat(64),
            byteSize: 64,
            kind: "semantic-ir",
          },
        ],
        repairBudgetSnapshot: { limit: 3, used: 0, remaining: 3 },
        assistBudgetSnapshot: { limit: 1, used: 1, remaining: 0 },
        modelInvocationBudgetSnapshot: { limit: 6, used: 1, remaining: 5 },
        rationale: "Bounded ambiguity in OCCURS-resolution.",
      },
      finalClassification: null,
      failureCode: null,
      failureMessage: null,
      generatedJavaRef: null,
      buildTestResultRef: null,
      evidencePackRef: null,
    };
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify(payload),
    } as Response);

    const result = await apiClient.getRunWorkflow("run-assist-1");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.assistDecision?.outcome).toBe("assist_required");
      expect(result.data.assistDecision?.reasonCode).toBe(
        "semantic_ir_bounded_ambiguity",
      );
      expect(result.data.assistDecision?.selectedAgentRole).toBe(
        "transformation_agent",
      );
    }
  });

  it("rejects an assist-decision payload with an unknown outcome", async () => {
    const payload = {
      runId: "run-assist-bad",
      programId: "P",
      mode: "live",
      productMode: "live",
      source: "live",
      state: null,
      activeStep: null,
      activeAgent: null,
      agentAttemptCount: 0,
      repairBudget: null,
      assistBudget: null,
      modelInvocationBudget: null,
      repairAttempts: [],
      assistDecision: {
        outcome: "not_a_real_outcome",
        reasonCode: "caller_did_not_opt_in",
        decidedAt: "2026-05-17T12:00:00Z",
        selectedAgentRole: null,
        affectedArtifactRefs: [],
        repairBudgetSnapshot: null,
        assistBudgetSnapshot: null,
        modelInvocationBudgetSnapshot: null,
        rationale: null,
      },
      finalClassification: null,
      failureCode: null,
      failureMessage: null,
      generatedJavaRef: null,
      buildTestResultRef: null,
      evidencePackRef: null,
    };
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify(payload),
    } as Response);

    const result = await apiClient.getRunWorkflow("run-assist-bad");
    expect(result).toMatchObject({ ok: false, details: { kind: "contract" } });
  });

  it("rejects an assist-decision payload that violates the agent-role invariant", async () => {
    const payload = {
      runId: "run-assist-inv",
      programId: "P",
      mode: "live",
      productMode: "live",
      source: "live",
      state: null,
      activeStep: null,
      activeAgent: null,
      agentAttemptCount: 0,
      repairBudget: null,
      assistBudget: null,
      modelInvocationBudget: null,
      repairAttempts: [],
      // assist_required must carry a non-null selectedAgentRole; the
      // orchestrator-side invariant is mirrored on the Studio so an
      // upstream drift is rejected loudly.
      assistDecision: {
        outcome: "assist_required",
        reasonCode: "semantic_ir_bounded_ambiguity",
        decidedAt: "2026-05-17T12:00:00Z",
        selectedAgentRole: null,
        affectedArtifactRefs: [],
        repairBudgetSnapshot: null,
        assistBudgetSnapshot: null,
        modelInvocationBudgetSnapshot: null,
        rationale: null,
      },
      finalClassification: null,
      failureCode: null,
      failureMessage: null,
      generatedJavaRef: null,
      buildTestResultRef: null,
      evidencePackRef: null,
    };
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify(payload),
    } as Response);

    const result = await apiClient.getRunWorkflow("run-assist-inv");
    expect(result).toMatchObject({ ok: false, details: { kind: "contract" } });
  });
});
