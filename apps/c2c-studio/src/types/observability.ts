export interface RunExperienceView {
  runId: string;
  programId: string;
  mode: 'live' | 'diagnostic-fixture';
  productMode: 'live' | 'unavailable';
  summary?: string;
  observationPolicy?: string;
  detectedPatterns?: string[];
  artifactRefs?: string[];
}

export interface ModelGatewayHealth {
  status: 'ok' | 'unavailable';
  providerMode?: string;
  activeModelCount?: number;
  dataPolicy?: string;
  ledgerEnabled?: boolean;
  eventEmission?: boolean;
  error?: string;
}

export interface ModelGatewayModel {
  id: string;
  name: string;
  provider: string;
}

export interface ModelGatewayModels {
  models: ModelGatewayModel[];
  error?: string;
}

export interface HarnessReady {
  status: 'ok' | 'unavailable';
  summary?: string;
  error?: string;
}
