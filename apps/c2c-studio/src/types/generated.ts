import { GeneratedFileRef, OutputRef, GeneratedTraceability } from './api';

export type GeneratedArtifactState = 
  | 'idle'
  | 'pending'
  | 'unsupported'
  | 'incomplete'
  | 'generated'
  | 'failed-verification'
  | 'verified';

export interface FileTreeNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children: FileTreeNode[];
  ref?: GeneratedFileRef;
}

export interface ArtifactDetails {
  entryClass?: string;
  sha256?: string;
  buildState?: string; // 'ok' | 'compile-failed' | etc
  oracleParity?: string; // 'match' | 'divergence-known-w0-coverage-gap' | etc
  evidenceStatus?: string; // 'complete' | 'incomplete' | 'invalid'
  traceability?: GeneratedTraceability;
  missingArtifacts?: string[];
  unsupportedFeatures?: string[];
}
