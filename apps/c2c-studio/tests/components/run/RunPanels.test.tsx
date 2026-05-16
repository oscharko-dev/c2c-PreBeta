import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BuildTestPanel } from '../../../src/components/run/BuildTestPanel';
import { EvidencePackPanel } from '../../../src/components/run/EvidencePackPanel';
import { ProblemsPanel } from '../../../src/components/run/ProblemsPanel';
import { EquivalencePanel } from '../../../src/components/run/EquivalencePanel';
import { RunArtifactsPanel } from '../../../src/components/run/RunArtifactsPanel';

const mockState = {
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
  progress: null,
  artifacts: null,
  experience: null,
  modelGatewayHealth: null,
  harnessReady: null,
  workflow: null,
};

vi.mock('../../../src/stores/transformationRun', () => ({
  useTransformationRun: vi.fn(() => ({ state: mockState })),
}));

describe('Run Panels', () => {
  let useTransformationRunMock: any;
  
  beforeEach(async () => {
    vi.resetAllMocks();
    const mod = await import('../../../src/stores/transformationRun');
    useTransformationRunMock = mod.useTransformationRun;
  });

  describe('BuildTestPanel', () => {
    it('renders build/test status and classification correctly', () => {
      useTransformationRunMock.mockReturnValue({
        state: {
          ...mockState,
          phase: 'completed',
          buildTest: {
            status: 'ok',
            classification: 'match',
            expectedOutput: 'FOO',
            actualOutput: 'FOO'
          }
        }
      });
      render(<BuildTestPanel emptyState={{ title: 'Empty', message: 'Message' }} />);
      expect(screen.getByText('COBOL Oracle')).toBeDefined();
      expect(screen.getByText('Java Compilation')).toBeDefined();
      expect(screen.getByText('Java Execution')).toBeDefined();
      expect(screen.getByText('Equivalence Check')).toBeDefined();
      expect(screen.getByText('Match (Equivalent)')).toBeDefined();
    });

    it('renders build/test missing golden master', () => {
      useTransformationRunMock.mockReturnValue({
        state: {
          ...mockState,
          phase: 'completed',
          buildTest: {
            status: 'missing-golden-master',
            classification: 'skipped-no-execution'
          }
        }
      });
      render(<BuildTestPanel emptyState={{ title: 'Empty', message: 'Message' }} />);
      expect(screen.getByText('COBOL Oracle')).toBeDefined();
      expect(screen.getByText('Golden master unavailable')).toBeDefined();
      expect(screen.getByText('Blocked before compilation started')).toBeDefined();
    });

    it('renders live orchestrator progress steps when available', () => {
      useTransformationRunMock.mockReturnValue({
        state: {
          ...mockState,
          phase: 'running',
          progress: {
            runId: 'run-progress',
            programId: 'BRNCH01',
            mode: 'live',
            productMode: 'live',
            status: 'complete',
            currentStep: 'compile-test-java',
            failedStep: null,
            completedSteps: ['accepted', 'parse-cobol', 'generate-ir', 'generate-java'],
            stepCount: 3,
            steps: [
              {
                stepId: 1,
                name: 'accepted',
                capabilityId: 'orchestrator-service',
                service: 'orchestrator-service',
                actor: 'orchestrator-service',
                status: 'ok'
              },
              {
                stepId: 2,
                name: 'generate-java',
                capabilityId: 'java-generator-service',
                service: 'orchestrator-service',
                actor: 'java-generator-service',
                status: 'ok',
                latencyMs: 31
              },
              {
                stepId: 3,
                name: 'compile-test-java',
                capabilityId: 'build-test-runner',
                service: 'orchestrator-service',
                actor: 'build-test-runner',
                status: 'running'
              }
            ]
          }
        }
      });

      render(<BuildTestPanel emptyState={{ title: 'Empty', message: 'Message' }} />);
      expect(screen.getByText('Accepted')).toBeDefined();
      expect(screen.getByText('Generate Java')).toBeDefined();
      expect(screen.getByText('Compile & Test Java')).toBeDefined();
      expect(screen.getByText('build-test-runner is running')).toBeDefined();
    });
  });

  describe('EquivalencePanel', () => {
    it('renders expected vs actual output correctly', () => {
      render(
        <EquivalencePanel 
          isPending={false}
          buildTest={{
            runId: '123',
            programId: '456',
            mode: 'live',
            productMode: 'live',
            status: 'ok',
            classification: 'divergence-unknown',
            expectedOutput: 'Line 1\nLine 2',
            actualOutput: 'Line A\nLine B',
            generatedArtifactRef: null
          }} 
        />
      );
      expect(screen.getByText('Divergence (Unknown)')).toBeDefined();
      expect(screen.getByText('Line 1')).toBeDefined();
      expect(screen.getByText('Line 2')).toBeDefined();
      expect(screen.getByText('Line A')).toBeDefined();
      expect(screen.getByText('Line B')).toBeDefined();
    });

    it('distinguishes known W0 coverage gaps from unknown divergence', () => {
      render(
        <EquivalencePanel
          isPending={false}
          buildTest={{
            runId: '123',
            programId: '456',
            mode: 'live',
            productMode: 'live',
            status: 'output-divergence',
            classification: 'divergence-known-w0-coverage-gap',
            expectedOutput: 'COBOL',
            actualOutput: 'JAVA',
            generatedArtifactRef: null
          }}
        />
      );

      expect(screen.getByText('Divergence (Known W0 Gap)')).toBeDefined();
      expect(screen.queryByText('Divergence (Unknown)')).not.toBeInTheDocument();
    });
  });

  describe('EvidencePackPanel', () => {
    it('renders evidence complete correctly', () => {
      useTransformationRunMock.mockReturnValue({
        state: {
          ...mockState,
          phase: 'completed',
          generated: {
            artifactRef: {
              sha256: 'abc123'
            }
          },
          buildTest: {
            generatedArtifactRef: {
              sha256: 'abc123'
            }
          },
          evidence: {
            status: 'complete',
            packId: 'pack-123',
            manifestHash: 'manifest-sha-123',
            generatedArtifactRef: {
              sha256: 'abc123'
            }
          }
        }
      });
      render(<EvidencePackPanel emptyState={{ title: 'Empty', message: 'Message' }} />);
      expect(screen.getByText('Evidence Pack Complete')).toBeDefined();
      expect(screen.getByText('pack-123')).toBeDefined();
      expect(screen.getByText('manifest-sha-123')).toBeDefined();
      expect(screen.getByText('All required artifacts are present.')).toBeDefined();
      expect(screen.getByText('Displayed Java, build/test, and evidence all reference the same generated artifact.')).toBeDefined();
    });

    it('renders evidence incomplete with missing artifacts correctly', () => {
      useTransformationRunMock.mockReturnValue({
        state: {
          ...mockState,
          phase: 'completed',
          evidence: {
            status: 'incomplete',
            missingArtifacts: ['Missing1', 'Missing2']
          }
        }
      });
      render(<EvidencePackPanel emptyState={{ title: 'Empty', message: 'Message' }} />);
      expect(screen.getByText('Evidence Pack Incomplete')).toBeDefined();
      expect(screen.getByText('Missing1')).toBeDefined();
      expect(screen.getByText('Missing2')).toBeDefined();
    });

    it('does not render a success headline when artifact references are mismatched', () => {
      useTransformationRunMock.mockReturnValue({
        state: {
          ...mockState,
          phase: 'completed',
          generated: {
            artifactRef: {
              uri: 'air://generated',
              sha256: 'abc123'
            }
          },
          buildTest: {
            generatedArtifactRef: {
              uri: 'air://build-test',
              sha256: 'def456'
            }
          },
          evidence: {
            status: 'complete',
            generatedArtifactRef: {
              uri: 'air://evidence',
              sha256: 'abc123'
            }
          }
        }
      });

      render(<EvidencePackPanel emptyState={{ title: 'Empty', message: 'Message' }} />);
      expect(screen.getByText('Evidence Pack Mismatch Detected')).toBeDefined();
      expect(screen.queryByText('Evidence Pack Complete')).not.toBeInTheDocument();
    });
  });

  describe('RunArtifactsPanel', () => {
    it('renders artifact list hash/path correctly', () => {
      const artifacts = [
        {
          path: '/path/to/art1',
          name: 'art1',
          kind: 'source',
          byteSize: 1234,
          sha256: 'hash123',
          createdBy: 'system',
          createdAt: '2026-05-15T12:00:00Z',
          uri: 'uri1',
          runId: 'run1',
          workflowId: 'wf1'
        }
      ];
      render(<RunArtifactsPanel artifacts={artifacts} />);
      expect(screen.getByText('/path/to/art1')).toBeDefined();
      expect(screen.getByText('source')).toBeDefined();
      expect(screen.getByText('1234')).toBeDefined();
      expect(screen.getByText('hash123')).toBeDefined();
    });

    it('renders artifact fetch errors separately from the artifact list', () => {
      render(<RunArtifactsPanel artifacts={[]} errorMessage="artifacts endpoint returned 503" />);
      expect(screen.getByText('Artifacts fetch failed')).toBeDefined();
      expect(screen.getByText('artifacts endpoint returned 503')).toBeDefined();
    });
  });

  describe('ProblemsPanel', () => {
    it('derives issues from features, missing artifacts, failed statuses, and hash mismatches', () => {
      useTransformationRunMock.mockReturnValue({
        state: {
          ...mockState,
          phase: 'completed',
          generated: {
            unsupportedFeatures: ['GOTO', 'ALTER'],
            missingArtifacts: ['GenMiss'],
            artifactRef: {
              uri: 'air://generated',
              sha256: 'aaa'
            }
          },
          generatedFiles: {
            missingArtifacts: ['FilesMiss']
          },
          buildTest: {
            status: 'compile-failed',
            classification: 'compile-error',
            generatedArtifactRef: {
              uri: 'air://build-test',
              sha256: 'bbb'
            }
          },
          evidence: {
            status: 'incomplete',
            generatedArtifactRef: {
              uri: 'air://evidence',
              sha256: 'ccc'
            }
          },
          artifactsError: 'artifact endpoint failed'
        }
      });
      render(<ProblemsPanel emptyState={{ title: 'Empty', message: 'Message' }} />);
      expect(screen.getByText('GOTO')).toBeDefined();
      expect(screen.getByText('ALTER')).toBeDefined();
      expect(screen.getByText('GenMiss')).toBeDefined();
      expect(screen.getByText('FilesMiss')).toBeDefined();
      expect(screen.getByText('compile-failed')).toBeDefined();
      expect(screen.getByText('The evidence pack is missing required artifacts')).toBeDefined();
      expect(screen.getByText('artifact endpoint failed')).toBeDefined();
      expect(screen.getByText('Generated Java, build/test, and evidence do not reference the same artifact hash')).toBeDefined();
    });
  });

  describe('RunLifecyclePanel', () => {
    it('renders lifecycle events when available', async () => {
      const { RunLifecyclePanel } = await import('../../../src/components/run/RunLifecyclePanel');
      useTransformationRunMock.mockReturnValue({
        state: {
          ...mockState,
          phase: 'completed',
          events: {
            events: [
              {
                createdAt: '2026-05-15T12:00:00Z',
                type: 'run.completed',
                status: 'completed',
                message: 'Transformation finished'
              }
            ]
          }
        }
      });
      render(<RunLifecyclePanel emptyState={{ title: 'Empty', message: 'Message' }} />);
      expect(screen.getByText('run.completed')).toBeDefined();
      expect(screen.getByText('Transformation finished')).toBeDefined();
    });
  });
});
