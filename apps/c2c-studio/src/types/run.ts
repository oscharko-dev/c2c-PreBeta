import {
  RunExperienceView,
  ModelGatewayHealth,
  HarnessReady,
} from "./observability";
import {
  RunSummary,
  GeneratedView,
  GeneratedFilesIndex,
  BuildTestView,
  EvidenceView,
  RunEventsView,
  RunProgressView,
  RunArtifactsView,
  RunWorkflowView,
} from "./api";

export type RunPhase =
  | "idle"
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "unavailable"
  | "incomplete";

export interface TransformationRunState {
  phase: RunPhase;
  runId: string | null;
  orchestratorRunId: string | null;
  programId: string | null;
  error: string | null;
  artifactsError: string | null;

  // Artifact views
  summary: RunSummary | null;
  generated: GeneratedView | null;
  generatedFiles: GeneratedFilesIndex | null;
  buildTest: BuildTestView | null;
  evidence: EvidenceView | null;
  events: RunEventsView | null;
  progress: RunProgressView | null;
  artifacts: RunArtifactsView | null;
  experience: RunExperienceView | null;
  modelGatewayHealth: ModelGatewayHealth | null;
  harnessReady: HarnessReady | null;
  // Issue #173: W0.2 workflow contract view (activeAgent, repairAttempts,
  // repairBudget, finalClassification, failureCode). Polled alongside the
  // legacy /runs/{id} summary so the Studio can show agentic workflow
  // progress without re-deriving from artifact views.
  workflow: RunWorkflowView | null;
  // Issue #358: preserve the immediately previous artifact-bearing run so
  // Studio can keep stale Java, parity results, and evidence visible while a
  // rerun is in flight or when the latest rerun fails.
  previousRun: HistoricalRunSnapshot | null;
}

export interface HistoricalRunSnapshot {
  runId: string;
  orchestratorRunId: string | null;
  programId: string | null;
  phase: RunPhase;
  summary: RunSummary | null;
  generated: GeneratedView | null;
  generatedFiles: GeneratedFilesIndex | null;
  buildTest: BuildTestView | null;
  evidence: EvidenceView | null;
  events: RunEventsView | null;
  progress: RunProgressView | null;
  artifacts: RunArtifactsView | null;
  experience: RunExperienceView | null;
  workflow: RunWorkflowView | null;
}
