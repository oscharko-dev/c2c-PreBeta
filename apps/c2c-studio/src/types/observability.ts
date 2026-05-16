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
  policyId?: string;
  roleAvailability?: ModelGatewayRoleAvailability[];
  error?: string;
}

export interface ModelGatewayRoleAvailability {
  role: string;
  status: string;
  policyId?: string;
  availableModels: string[];
  configuredModels: string[];
  reason?: string;
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
