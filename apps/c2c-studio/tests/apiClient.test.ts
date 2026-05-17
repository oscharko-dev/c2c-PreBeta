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
        generatedArtifactRef: {
          sha256: "a".repeat(64),
          byteSize: 128,
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
});
