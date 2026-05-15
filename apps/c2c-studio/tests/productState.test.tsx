import { describe, expect, it } from 'vitest';
import { deriveProductState } from '../src/types/state';
import { TransformationRunState } from '../src/types/run';

describe('Product State Derivation', () => {
  function makeState(overrides: Partial<TransformationRunState> = {}): TransformationRunState {
    return {
      phase: 'idle',
      runId: null,
      orchestratorRunId: null,
      programId: null,
      error: null,
      artifactsError: null,
      summary: null,
      generated: null,
      generatedFiles: null,
      buildTest: null,
      evidence: null,
      events: null,
      artifacts: null,
      experience: null,
      modelGatewayHealth: null,
      harnessReady: null,
      ...overrides
    };
  }

  it('BFF unavailable disables start (backend-unavailable)', () => {
    const state = makeState({ error: 'Backend unavailable. Try again shortly.' });
    expect(deriveProductState(state).state).toBe('backend-unavailable');
  });

  it('Transform returns 400 (validation-error)', () => {
    const state = makeState({ error: 'HTTP 400 Bad Request' });
    expect(deriveProductState(state).state).toBe('validation-error');
  });

  it('Transform returns 503 and product readiness is blocked (backend-unavailable)', () => {
    const state = makeState({ error: 'HTTP 503 Service Unavailable' });
    expect(deriveProductState(state).state).toBe('backend-unavailable');
  });

  it('Generated endpoint returns incomplete with missing artifacts', () => {
    const state = makeState({
      phase: 'completed',
      generated: {
        runId: '123',
        programId: 'ABC',
        mode: 'live',
        productMode: 'live',
        status: 'incomplete',
        missingArtifacts: ['Foo.java'],
        artifactRef: null
      }
    });
    const result = deriveProductState(state);
    expect(result.state).toBe('generated-incomplete');
    expect(result.missingArtifacts).toEqual(['Foo.java']);
  });

  it('Build/test classification is divergence-known W0 coverage gap', () => {
    const state = makeState({
      phase: 'completed',
      generated: { status: 'generated', artifactRef: { uri: '', sha256: 'a' } } as any,
      buildTest: {
        runId: '123',
        programId: 'ABC',
        mode: 'live',
        productMode: 'live',
        status: 'output-divergence',
        classification: 'divergence-known-w0-coverage-gap',
        generatedArtifactRef: { uri: '', sha256: 'a' }
      }
    });
    const result = deriveProductState(state);
    expect(result.state).toBe('equivalence-mismatch');
  });

  it('Build/test classification is divergence-unknown', () => {
    const state = makeState({
      phase: 'completed',
      generated: { status: 'generated', artifactRef: { uri: '', sha256: 'a' } } as any,
      buildTest: {
        runId: '123',
        programId: 'ABC',
        mode: 'live',
        productMode: 'live',
        status: 'output-divergence',
        classification: 'divergence-unknown',
        generatedArtifactRef: { uri: '', sha256: 'a' }
      }
    });
    const result = deriveProductState(state);
    expect(result.state).toBe('equivalence-mismatch');
  });

  it('Evidence incomplete with missing artifacts', () => {
    const state = makeState({
      phase: 'completed',
      generated: { status: 'generated', artifactRef: { uri: '', sha256: 'a' } } as any,
      buildTest: { status: 'ok', classification: 'match', generatedArtifactRef: { uri: '', sha256: 'a' } } as any,
      evidence: {
        runId: '123',
        programId: 'ABC',
        mode: 'live',
        productMode: 'live',
        status: 'incomplete',
        missingArtifacts: ['manifest.json'],
        generatedArtifactRef: { uri: '', sha256: 'a' }
      }
    });
    const result = deriveProductState(state);
    expect(result.state).toBe('evidence-incomplete');
    expect(result.missingArtifacts).toEqual(['manifest.json']);
  });

  it('Artifact hash mismatch blocks verified state', () => {
    const state = makeState({
      phase: 'completed',
      generated: {
        runId: '123',
        programId: 'ABC',
        mode: 'live',
        productMode: 'live',
        status: 'generated',
        artifactRef: { uri: 'abc', sha256: 'hash1' }
      },
      buildTest: {
        runId: '123',
        programId: 'ABC',
        mode: 'live',
        productMode: 'live',
        status: 'ok',
        classification: 'match',
        generatedArtifactRef: { uri: 'def', sha256: 'hash2' }
      }
    });
    const result = deriveProductState(state);
    expect(result.state).toBe('hash-mismatch');
    expect(result.mismatchedHashes).toBeDefined();
    expect(result.mismatchedHashes?.[0].expected).toBe('hash1');
    expect(result.mismatchedHashes?.[0].actual).toBe('hash2');
  });
});
