import { 
  RunExperienceView, 
  ModelGatewayHealth, 
  HarnessReady 
} from './observability';
import { 
  RunSummary, 
  GeneratedView, 
  GeneratedFilesIndex, 
  BuildTestView, 
  EvidenceView, 
  RunEventsView, 
  RunArtifactsView 
} from './api';

export type RunPhase =
  | 'idle'
  | 'starting'
  | 'running'
  | 'completed'
  | 'failed'
  | 'unavailable'
  | 'incomplete'
  | 'verification-blocked';

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
  artifacts: RunArtifactsView | null;
  experience: RunExperienceView | null;
  modelGatewayHealth: ModelGatewayHealth | null;
  harnessReady: HarnessReady | null;
}
