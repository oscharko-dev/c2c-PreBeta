import { TransformationRunState } from './run';

export type ProductState =
  | 'empty'
  | 'ready'
  | 'backend-unavailable'
  | 'upstream-unavailable'
  | 'unsupported'
  | 'validation-error'
  | 'running'
  | 'failed'
  | 'generated-pending'
  | 'generated-incomplete'
  | 'build-failed'
  | 'equivalence-mismatch'
  | 'evidence-incomplete'
  | 'hash-mismatch'
  | 'stale-ignored';

export interface StateContext {
  state: ProductState;
  message?: string;
  missingArtifacts?: string[];
  unsupportedFeatures?: string[];
  mismatchedHashes?: { expected: string; actual: string; context: string }[];
}

export function deriveProductState(runState: TransformationRunState): StateContext {
  if (runState.error === 'Backend unavailable. Try again shortly.' || runState.error?.includes('503')) {
    return { state: 'backend-unavailable', message: runState.error };
  }
  if (runState.error?.includes('400') || runState.error?.includes('Validation')) {
    return { state: 'validation-error', message: runState.error };
  }
  if (runState.phase === 'idle') {
    return { state: 'empty' };
  }
  if (runState.summary?.productMode === 'unavailable') {
    return { state: 'upstream-unavailable', message: runState.summary.message };
  }
  if (runState.phase === 'starting' || runState.phase === 'running') {
    return { state: 'running' };
  }
  if (runState.phase === 'failed' || runState.summary?.status === 'failed') {
    return { state: 'failed', message: runState.error || runState.summary?.message };
  }
  
  const generated = runState.generated;
  if (generated) {
    if (generated.status === 'unsupported') {
      return { 
        state: 'unsupported', 
        unsupportedFeatures: generated.unsupportedFeatures || [],
        message: generated.note
      };
    }
    if (generated.status === 'incomplete' || (generated.missingArtifacts && generated.missingArtifacts.length > 0)) {
      return { 
        state: 'generated-incomplete', 
        missingArtifacts: generated.missingArtifacts || [],
        message: generated.note 
      };
    }
  } else if (runState.phase === 'completed' && !generated) {
    return { state: 'generated-pending' };
  }

  const buildTest = runState.buildTest;
  if (buildTest) {
    if (buildTest.status === 'compile-failed' || buildTest.status === 'run-failed' || buildTest.classification === 'compile-error' || buildTest.classification === 'run-error') {
      return { state: 'build-failed', message: buildTest.note };
    }
    if (buildTest.classification?.startsWith('divergence')) {
      return { state: 'equivalence-mismatch', message: buildTest.note };
    }
    if (buildTest.status === 'incomplete') {
       return { state: 'build-failed', message: 'Build test incomplete' };
    }
  }

  const evidence = runState.evidence;
  if (evidence) {
    if (evidence.status === 'incomplete' || (evidence.missingArtifacts && evidence.missingArtifacts.length > 0)) {
      return { 
        state: 'evidence-incomplete', 
        missingArtifacts: evidence.missingArtifacts || [],
        message: evidence.note
      };
    }
  }

  // Check hash mismatches
  const mismatches = [];
  if (generated?.artifactRef && buildTest?.generatedArtifactRef) {
    if (generated.artifactRef.sha256 !== buildTest.generatedArtifactRef.sha256) {
      mismatches.push({ 
        expected: generated.artifactRef.sha256, 
        actual: buildTest.generatedArtifactRef.sha256,
        context: 'Generated vs Build/Test'
      });
    }
  }
  if (generated?.artifactRef && evidence?.generatedArtifactRef) {
     if (generated.artifactRef.sha256 !== evidence.generatedArtifactRef.sha256) {
       mismatches.push({
         expected: generated.artifactRef.sha256,
         actual: evidence.generatedArtifactRef.sha256,
         context: 'Generated vs Evidence'
       });
     }
  }

  if (mismatches.length > 0) {
    return { state: 'hash-mismatch', mismatchedHashes: mismatches };
  }

  if (runState.phase === 'completed') {
    return { state: 'ready' };
  }

  return { state: 'empty' };
}
