import { randomUUID } from "node:crypto";
import {
  diagnosticFixtureOutcomeFor,
  type DiagnosticFixtureOutcome,
} from "./diagnostic-fixtures/fixture-data";
import type { SampleDetail } from "./samples";
import type { W02UiErrorCode } from "./error-codes";

export type RunStatus = "starting" | "updating" | "completed" | "failed";

// Issue #172: W0.2 final classification surfaced to the UI on /api/v0/runs/{runId}.
// ``success`` corresponds to a deterministic verification pass; ``blocked``
// and ``failed`` carry a UI-safe ``failureCode``; ``incomplete`` is the
// non-terminal placeholder used while the orchestrator is still running.
export type RunFinalClassification =
  | "success"
  | "blocked"
  | "failed"
  | "cancelled"
  | "incomplete";

export interface StoredRepairBudget {
  limit: number;
  used: number;
  remaining: number;
}

// Issue #216 (W0.3-5): per-run productive-assist activation budget surfaced
// from the orchestrator. Shape mirrors ``StoredRepairBudget`` so the UI can
// render any budget uniformly.
export interface StoredAssistBudget {
  limit: number;
  used: number;
  remaining: number;
}

// Issue #216 (W0.3-5): per-run Model Gateway invocation budget surfaced
// from the orchestrator. Same shape as the other budgets.
export interface StoredModelInvocationBudget {
  limit: number;
  used: number;
  remaining: number;
}
// `diagnostic-fixture` is an opt-in developer mode (C2C_ENABLE_DIAGNOSTIC_FIXTURES).
// It is never a product result and is contained out of product-facing DTOs by
// `productMode` in server responses.
export type RunMode = "live" | "diagnostic-fixture";
export type RunExecutionMode = "standard" | "parity";
export type SourceReferenceMode = "reference-fixture" | "native-cobol";

export interface StoredRun {
  runId: string;
  programId: string;
  executionMode?: RunExecutionMode;
  trustCaseId?: string;
  trustCaseVersion?: string;
  trustCaseCatalogVersion?: string;
  trustCaseCatalogHash?: string;
  trustCaseConfigurationDigest?: string;
  trustCaseEnvironmentProfileId?: string;
  trustCaseComparisonPolicyVersion?: string;
  sourceReferenceFixtureId?: string;
  sourceReferenceMode?: SourceReferenceMode;
  status: RunStatus;
  mode: RunMode;
  message: string;
  policyDecision: string;
  evidenceRefs: string[];
  trustSummary?: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  sample: SampleDetail;
  fixture?: DiagnosticFixtureOutcome;
  liveRunId?: string;
  // Issue #172: W0.2 contract fields derived from the orchestrator's
  // ``GET /v0/runs/{runId}/workflow`` view. They are optional because the
  // BFF caches the last-known snapshot and zeroes them for fixture runs.
  activeStep?: string;
  agentAttemptCount?: number;
  repairBudget?: StoredRepairBudget;
  // Issue #216 (W0.3-5): per-run productive-assist + Model Gateway budgets
  // surfaced from the orchestrator's W0.2 contract view.
  assistBudget?: StoredAssistBudget;
  modelInvocationBudget?: StoredModelInvocationBudget;
  finalClassification?: RunFinalClassification;
  failureCode?: W02UiErrorCode;
  failureMessage?: string;
  // ADR-0007 (#257): run-summary manual-edit provenance. Optional in the
  // cache so legacy in-memory records default to false/0 at projection time.
  manualEditsCarriedOver?: boolean;
  manualDriftRegionCount?: number;
  // Studio-IDE-6 (#248): per-file Java region classification surfaced from
  // the orchestrator's traceability payload and cached on the run.
  javaRegionClassification?: Record<string, unknown[]> | null;
}

export interface RunStore {
  create(
    sample: SampleDetail,
    mode: RunMode,
    liveRunId?: string,
    initial?: Partial<StoredRun>,
  ): StoredRun;
  get(runId: string): StoredRun | undefined;
  update(runId: string, patch: Partial<StoredRun>): StoredRun | undefined;
  list(): StoredRun[];
}

export function createRunStore(
  now: () => Date = () => new Date(),
  idFactory: () => string = randomUUID,
): RunStore {
  const runs = new Map<string, StoredRun>();
  return {
    create(sample, mode, liveRunId, initial) {
      const runId = `run-${idFactory()}`;
      const createdAt = now().toISOString();
      const stored: StoredRun = {
        runId,
        programId: sample.programId,
        executionMode: initial?.executionMode,
        trustCaseId: initial?.trustCaseId,
        trustCaseVersion: initial?.trustCaseVersion,
        trustCaseCatalogVersion: initial?.trustCaseCatalogVersion,
        trustCaseCatalogHash: initial?.trustCaseCatalogHash,
        trustCaseConfigurationDigest: initial?.trustCaseConfigurationDigest,
        trustCaseEnvironmentProfileId: initial?.trustCaseEnvironmentProfileId,
        trustCaseComparisonPolicyVersion:
          initial?.trustCaseComparisonPolicyVersion,
        sourceReferenceFixtureId: initial?.sourceReferenceFixtureId,
        sourceReferenceMode: initial?.sourceReferenceMode,
        status: initial?.status ?? "starting",
        mode,
        message:
          initial?.message ??
          (mode === "diagnostic-fixture"
            ? "diagnostic fixture run; not a product result"
            : "run accepted by orchestrator"),
        policyDecision: initial?.policyDecision ?? "",
        evidenceRefs: initial?.evidenceRefs ?? [],
        trustSummary: initial?.trustSummary,
        createdAt,
        updatedAt: createdAt,
        sample,
        fixture:
          mode === "diagnostic-fixture"
            ? diagnosticFixtureOutcomeFor(sample, runId)
            : undefined,
        liveRunId,
      };
      runs.set(runId, stored);
      return stored;
    },
    get(runId) {
      return runs.get(runId);
    },
    update(runId, patch) {
      const existing = runs.get(runId);
      if (!existing) return undefined;
      const updated: StoredRun = {
        ...existing,
        ...patch,
        updatedAt: now().toISOString(),
      };
      runs.set(runId, updated);
      return updated;
    },
    list() {
      return Array.from(runs.values());
    },
  };
}

function isAllowedStatus(value: unknown): value is RunStatus {
  return (
    value === "starting" ||
    value === "updating" ||
    value === "completed" ||
    value === "failed"
  );
}

export function coerceLiveStatus(value: unknown): RunStatus {
  return isAllowedStatus(value) ? value : "updating";
}
