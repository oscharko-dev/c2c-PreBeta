export type RunStatus = 'starting' | 'updating' | 'completed' | 'failed';
export type GeneratedStatus = 'generated' | 'unsupported' | 'skipped' | 'incomplete';
export type EvidenceStatus = 'complete' | 'incomplete';
export type ProductMode = 'live' | 'unavailable';

export type StatusVariant = 
  | 'error' 
  | 'warning' 
  | 'blocked' 
  | 'pending' 
  | 'success' 
  | 'neutral' 
  | 'incomplete';

export const mapRunStatusToVariant = (status: RunStatus): StatusVariant => {
  switch (status) {
    case 'starting':
    case 'updating': return 'pending';
    case 'completed': return 'success';
    case 'failed': return 'error';
    default: return 'neutral';
  }
};

export const mapGeneratedStatusToVariant = (status: GeneratedStatus): StatusVariant => {
  switch (status) {
    case 'generated': return 'success';
    case 'skipped': return 'neutral';
    case 'unsupported': return 'warning';
    case 'incomplete': return 'incomplete';
    default: return 'neutral';
  }
};

export const mapEvidenceStatusToVariant = (status: EvidenceStatus): StatusVariant => {
  switch (status) {
    case 'complete': return 'success';
    case 'incomplete': return 'incomplete';
    default: return 'neutral';
  }
};
