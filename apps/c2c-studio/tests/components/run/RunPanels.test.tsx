import { fireEvent, render, screen } from '@testing-library/react';
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
  previousRun: null,
};

const navigateToDiagnosticMock = vi.hoisted(() => vi.fn());

vi.mock('../../../src/stores/transformationRun', () => ({
  useTransformationRun: vi.fn(() => ({ state: mockState })),
}));

vi.mock('../../../src/stores/sourceWorkspace', () => ({
  useSourceWorkspace: vi.fn(() => ({
    statusFlags: {
      clean: true,
      pendingReRun: false,
    },
  })),
}));

vi.mock('@/lib/editor/markerNavigation', () => ({
  useMarkerNavigation: () => ({
    navigateToDiagnostic: navigateToDiagnosticMock,
  }),
}));

describe('Run Panels', () => {
  let useTransformationRunMock: any;
  let useSourceWorkspaceMock: any;
  
  beforeEach(async () => {
    vi.resetAllMocks();
    const mod = await import('../../../src/stores/transformationRun');
    useTransformationRunMock = mod.useTransformationRun;
    const sourceMod = await import('../../../src/stores/sourceWorkspace');
    useSourceWorkspaceMock = sourceMod.useSourceWorkspace;
    useSourceWorkspaceMock.mockReturnValue({
      statusFlags: {
        clean: true,
        pendingReRun: false,
      },
      selectedTrustCase: null,
    });
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
      expect(screen.getByRole('tab', { name: /Transform/ })).toBeDefined();
      expect(screen.getByRole('tab', { name: /COBOL Reference Execution/ })).toBeDefined();
      expect(screen.getByRole('tab', { name: /Java Build/ })).toBeDefined();
      expect(screen.getByRole('tab', { name: /Java Execution/ })).toBeDefined();
      expect(screen.getByRole('tab', { name: /Parity Comparison/ })).toBeDefined();
      expect(screen.getAllByText('Pass').length).toBeGreaterThan(0);
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
      expect(screen.getByRole('tab', { name: /COBOL Reference Execution/ })).toBeDefined();
      expect(screen.getAllByText('Waiting for backend evidence').length).toBeGreaterThan(0);
      expect(screen.getAllByText(/Not executed/i).length).toBeGreaterThan(0);
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
      expect(screen.getByRole('tab', { name: /Transform/ })).toBeDefined();
      expect(screen.getByRole('tab', { name: /Java Build/ })).toBeDefined();
      expect(screen.getByText('build-test-runner is running')).toBeDefined();
    });

    it('renders model policy skipped progress without raw diagnostic leakage', () => {
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
            currentStep: null,
            failedStep: null,
            completedSteps: ['accepted', 'model-policy-skipped'],
            stepCount: 2,
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
                name: 'model-policy-skipped',
                capabilityId: 'orchestrator-service',
                service: 'orchestrator-service',
                actor: 'orchestrator-service',
                status: 'skipped',
                diagnostic: 'Step skipped by workflow policy.'
              }
            ]
          }
        }
      });

      render(<BuildTestPanel emptyState={{ title: 'Empty', message: 'Message' }} />);
      expect(screen.getByRole('tab', { name: /Transform/ })).toBeDefined();
      expect(screen.getAllByText('Skipped: Step skipped by workflow policy.').length).toBeGreaterThan(0);
    });

    it('marks parity results stale when the source workspace has pending re-run state', () => {
      useSourceWorkspaceMock.mockReturnValue({
        statusFlags: {
          clean: false,
          pendingReRun: true,
        },
        selectedTrustCase: null,
      });
      useTransformationRunMock.mockReturnValue({
        state: {
          ...mockState,
          phase: 'completed',
          buildTest: {
            status: 'ok',
            classification: 'match',
            expectedOutput: 'OK',
            actualOutput: 'OK',
          },
        },
      });

      render(<BuildTestPanel emptyState={{ title: 'Empty', message: 'Message' }} />);
      expect(
        screen.getByText(
          'COBOL source changed after the last completed parity run. These parity results are stale until you rerun.',
        ),
      ).toBeDefined();
    });

    it('renders compile failure stages and failure note', () => {
      useTransformationRunMock.mockReturnValue({
        state: {
          ...mockState,
          phase: 'completed',
          buildTest: {
            status: 'compile-failed',
            classification: 'compile-error',
            note: 'javac failed with type mismatch'
          }
        }
      });
      render(<BuildTestPanel emptyState={{ title: 'Empty', message: 'Message' }} />);
      expect(screen.getByRole('tab', { name: /Parity Comparison/ })).toBeDefined();
      expect(screen.getAllByText('Blocked by compilation failure').length).toBeGreaterThan(0);
      expect(screen.getAllByText('Java compilation failed before equivalence could run.').length).toBeGreaterThan(0);
      expect(screen.getAllByText('javac failed with type mismatch').length).toBeGreaterThan(0);
    });

    it('renders the trust summary card with read-only trust, result, and evidence data', () => {
      useSourceWorkspaceMock.mockReturnValue({
        statusFlags: {
          clean: true,
          pendingReRun: false,
        },
        selectedTrustCase: {
          trustCaseId: 'TC-ALPHA',
          version: 'v7',
          catalogVersion: '2026.05',
          catalogHash: 'catalog-hash',
          configurationDigest: 'config-hash',
          programId: 'PROG-1',
          title: 'Trust Case Alpha',
          description: 'Read-only trust case for verification.',
          defaultForProgram: true,
          sourceReferenceFixtureId: 'fixture-alpha',
          sourceReferenceMode: 'live',
          environmentProfileId: 'env-prod',
          comparisonStrategy: 'strict',
          comparisonPolicyVersion: 'policy-4',
          supportedSubset: [],
        },
      });

      useTransformationRunMock.mockReturnValue({
        state: {
          ...mockState,
          phase: 'completed',
          summary: {
            ...mockState.summary,
            runId: 'run-123',
            programId: 'PROG-1',
            trustCaseId: 'TC-ALPHA',
            trustCaseVersion: 'v7',
            trustCaseCatalogVersion: '2026.05',
            trustCaseConfigurationDigest: 'config-hash',
            trustCaseEnvironmentProfileId: 'env-prod',
            trustCaseComparisonPolicyVersion: 'policy-4',
          },
          buildTest: {
            runId: 'run-123',
            programId: 'PROG-1',
            mode: 'live',
            productMode: 'live',
            status: 'ok',
            classification: 'match',
            compileStatus: 'ok',
            executionStatus: 'ok',
            expectedOutput: 'COBOL',
            actualOutput: 'JAVA',
            expectedOutputRef: {
              sha256: 'e'.repeat(64),
              byteSize: 12,
              kind: 'cobol-oracle-stdout',
            },
            actualOutputRef: {
              sha256: 'a'.repeat(64),
              byteSize: 13,
              kind: 'java-stdout',
            },
            generatedArtifactRef: {
              sha256: 'g'.repeat(64),
              byteSize: 21,
              kind: 'generated-artifact',
            },
            comparison: {
              status: 'complete',
              comparisonPolicyRef: {
                sha256: 'p'.repeat(64),
                byteSize: 7,
                kind: 'comparison-policy',
              },
              comparisonResultRef: {
                sha256: 'r'.repeat(64),
                byteSize: 8,
                kind: 'comparison-result',
              },
              diffRef: {
                sha256: 'd'.repeat(64),
                byteSize: 9,
                kind: 'comparison-diff',
              },
              expectedRef: {
                sha256: 'e'.repeat(64),
                byteSize: 12,
                kind: 'cobol-oracle-stdout',
              },
              actualRef: {
                sha256: 'a'.repeat(64),
                byteSize: 13,
                kind: 'java-stdout',
              },
            },
            note: 'Comparison summary is published for audit.',
          },
          evidence: {
            runId: 'run-123',
            programId: 'PROG-1',
            mode: 'live',
            productMode: 'live',
            status: 'complete',
            packId: 'pack-123',
            manifestHash: 'manifest-123',
            artifactRef: {
              sha256: 'm'.repeat(64),
              byteSize: 17,
              kind: 'evidence-manifest',
              createdAt: '2026-05-21T12:34:56.000Z',
            },
            exportRef: {
              sha256: 'x'.repeat(64),
              byteSize: 19,
              kind: 'evidence-export',
            },
            generatedArtifactRef: {
              sha256: 'g'.repeat(64),
              byteSize: 21,
              kind: 'generated-artifact',
            },
            note: 'Evidence bundle is signed and archived.',
          },
          workflow: {
            runId: 'run-123',
            programId: 'PROG-1',
            mode: 'live',
            productMode: 'live',
            source: 'live',
            state: 'verifying',
            activeStep: 'verification-repair',
            activeAgent: 'verification_repair_agent',
            trustCase: {
              trustCaseId: 'TC-ALPHA',
            },
            agentAttemptCount: 1,
            repairBudget: {
              limit: 3,
              used: 1,
              remaining: 2,
            },
            assistBudget: null,
            modelInvocationBudget: null,
            repairAttempts: [
              {
                attemptNumber: 1,
                repairDecision: 'propose_candidate',
                failureCategory: null,
                hasModelInvocation: true,
                hasRepairInput: true,
                hasJavaCandidate: true,
                rationale: 'Repair candidate accepted for review.',
              },
            ],
            assistDecision: null,
            finalClassification: 'failed',
            failureCode: 'oracle_mismatch',
            failureMessage: 'Repair guardrail escalated to manual review.',
            generatedJavaRef: null,
            buildTestResultRef: null,
            evidencePackRef: null,
          },
        },
      });

      render(<BuildTestPanel emptyState={{ title: 'Empty', message: 'Message' }} />);

      expect(screen.getByText('Trust Summary')).toBeDefined();
      expect(screen.getByText('Trust Case Alpha')).toBeDefined();
      expect(screen.getByText('TC-ALPHA')).toBeDefined();
      expect(screen.getByText('COBOL result')).toBeDefined();
      expect(screen.getByText('Java result')).toBeDefined();
      expect(screen.getAllByText('Comparison result').length).toBeGreaterThan(0);
      expect(screen.getByText('Repair status')).toBeDefined();
      expect(screen.getByText('Evidence timestamp')).toBeDefined();
      expect(screen.getAllByText('2026-05-21T12:34:56.000Z').length).toBeGreaterThan(0);
      expect(screen.getAllByText('Comparison summary is published for audit.').length).toBeGreaterThan(0);
      expect(screen.getAllByText('Evidence bundle is signed and archived.').length).toBeGreaterThan(0);
      expect(screen.getAllByText('Repair guardrail escalated to manual review.').length).toBeGreaterThan(0);
      expect(screen.getByText('pack-123')).toBeDefined();
      expect(screen.getByText('rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr')).toBeDefined();
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
            expectedOutputRef: { sha256: 'e'.repeat(64), byteSize: 13, kind: 'cobol-oracle-stdout' },
            actualOutputRef: { sha256: 'a'.repeat(64), byteSize: 14, kind: 'java-stdout' },
            generatedArtifactRef: null
          }} 
        />
      );
      expect(screen.getByText('Mismatch detected')).toBeDefined();
      expect(screen.getAllByText('Expected output').length).toBeGreaterThan(0);
      expect(screen.getAllByText('Actual output').length).toBeGreaterThan(0);
      expect(screen.getAllByText(/Cobol Oracle Stdout/).length).toBeGreaterThan(1);
      expect(screen.getAllByText(/Java Stdout/).length).toBeGreaterThan(0);
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

      expect(screen.getByText('Known divergence')).toBeDefined();
      expect(screen.queryByText('Mismatch detected')).not.toBeInTheDocument();
    });

    it('renders a blocked parity label for compile failures', () => {
      render(
        <EquivalencePanel
          isPending={false}
          buildTest={{
            runId: '123',
            programId: '456',
            mode: 'live',
            productMode: 'live',
            status: 'compile-failed',
            classification: 'compile-error',
            generatedArtifactRef: null
          }}
        />
      );

      expect(screen.getAllByText('Blocked by compilation failure').length).toBeGreaterThan(0);
      expect(screen.queryByText('Mismatch detected')).not.toBeInTheDocument();
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

    it('marks current evidence stale after a COBOL edit', () => {
      useSourceWorkspaceMock.mockReturnValue({
        statusFlags: {
          clean: false,
          pendingReRun: true,
        },
        selectedTrustCase: null,
      });
      useTransformationRunMock.mockReturnValue({
        state: {
          ...mockState,
          phase: 'completed',
          evidence: {
            status: 'complete',
            packId: 'pack-stale',
            manifestHash: 'manifest-stale',
            generatedArtifactRef: {
              sha256: 'abc123',
            },
          },
        },
      });

      render(<EvidencePackPanel emptyState={{ title: 'Empty', message: 'Message' }} />);
      expect(
        screen.getByText('COBOL source changed after the last completed parity run. The current evidence pack is stale until you rerun.'),
      ).toBeDefined();
    });

    it('marks current evidence stale when Java buffers diverge from the generator baseline', () => {
      useTransformationRunMock.mockReturnValue({
        state: {
          ...mockState,
          phase: 'completed',
          evidence: {
            status: 'complete',
            packId: 'pack-drift',
            manifestHash: 'manifest-drift',
            generatedArtifactRef: {
              sha256: 'abc123',
            },
          },
        },
        manualDriftSummary: () => ({
          hasManualEdits: true,
          fileCount: 2,
          regionCount: 3,
          baselineRunIds: ['run-123'],
        }),
      });

      render(<EvidencePackPanel emptyState={{ title: 'Empty', message: 'Message' }} />);
      expect(
        screen.getAllByText(
          'Current Java diverges from run run-123. 2 files and 3 regions carry manual edit provenance, so build/test and evidence are stale until you rerun.',
        ).length,
      ).toBeGreaterThan(0);
    });

    it('marks evidence produced by another trust case or catalog version', () => {
      useSourceWorkspaceMock.mockReturnValue({
        statusFlags: {
          clean: true,
          pendingReRun: false,
        },
        selectedTrustCase: {
          trustCaseId: 'CURRENT-CASE',
          configurationDigest: 'current-digest',
        },
      });
      useTransformationRunMock.mockReturnValue({
        state: {
          ...mockState,
          phase: 'completed',
          summary: {
            trustCaseId: 'OLD-CASE',
            trustCaseConfigurationDigest: 'old-digest',
          },
          generated: {
            artifactRef: {
              sha256: 'abc123',
            },
          },
          buildTest: {
            generatedArtifactRef: {
              sha256: 'abc123',
            },
          },
          evidence: {
            status: 'complete',
            packId: 'pack-trust-case',
            manifestHash: 'manifest-trust-case',
            generatedArtifactRef: {
              sha256: 'abc123',
            },
          },
        },
      });

      render(<EvidencePackPanel emptyState={{ title: 'Empty', message: 'Message' }} />);
      expect(
        screen.getByText(/Existing evidence was produced from\s+OLD-CASE or a different catalog version\. Rerun to use\s+CURRENT-CASE\./),
      ).toBeDefined();
    });

    it('keeps previous evidence accessible when the latest rerun fails', () => {
      useTransformationRunMock.mockReturnValue({
        state: {
          ...mockState,
          phase: 'failed',
          evidence: null,
          previousRun: {
            runId: 'run-prev',
            orchestratorRunId: 'run-prev-orch',
            programId: 'P-1',
            phase: 'completed',
            summary: null,
            generated: {
              artifactRef: {
                sha256: 'abc123',
              },
            },
            generatedFiles: null,
            buildTest: {
              generatedArtifactRef: {
                sha256: 'abc123',
              },
            },
            evidence: {
              status: 'complete',
              packId: 'pack-prev',
              manifestHash: 'manifest-prev',
              generatedArtifactRef: {
                sha256: 'abc123',
              },
            },
            events: null,
            progress: null,
            artifacts: null,
            experience: null,
            workflow: null,
          },
        },
      });

      render(<EvidencePackPanel emptyState={{ title: 'Empty', message: 'Message' }} />);
      expect(screen.getByText('Previous Evidence Pack Complete')).toBeDefined();
      expect(
        screen.getByText('Latest rerun failed. Showing the previous evidence pack as stale so the last completed evidence remains accessible.'),
      ).toBeDefined();
      expect(screen.getByText('pack-prev')).toBeDefined();
    });

    it('does not render a success headline when artifact references are mismatched', () => {
      useTransformationRunMock.mockReturnValue({
        state: {
          ...mockState,
          phase: 'completed',
          generated: {
            artifactRef: {
              sha256: 'abc123',
              path: 'artifacts/generated.json'
            }
          },
          buildTest: {
            generatedArtifactRef: {
              sha256: 'def456',
              path: 'artifacts/build-test.json'
            }
          },
          evidence: {
            status: 'complete',
            generatedArtifactRef: {
              sha256: 'abc123',
              path: 'artifacts/evidence.json'
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
          path: 'artifacts/source.cbl',
          name: 'art1',
          kind: 'source',
          byteSize: 1234,
          sha256: 'hash123',
          createdBy: 'system',
          createdAt: '2026-05-15T12:00:00Z',
        }
      ];
      render(<RunArtifactsPanel artifacts={artifacts} />);
      expect(screen.getByRole('option', { name: /artifacts\/source\.cbl/i })).toBeDefined();
      expect(screen.getAllByText('source').length).toBeGreaterThan(0);
      expect(screen.getAllByText(/1234 bytes/).length).toBeGreaterThan(0);
      expect(screen.getAllByText('hash123').length).toBeGreaterThan(0);
    });

    it('renders artifact fetch errors separately from the artifact list', () => {
      render(<RunArtifactsPanel artifacts={[]} errorMessage="artifacts endpoint returned 503" />);
      expect(screen.getByText('Artifacts fetch failed')).toBeDefined();
      expect(screen.getByText('artifacts endpoint returned 503')).toBeDefined();
    });

    it('renders missing artifact records even when no artifact rows exist', () => {
      render(<RunArtifactsPanel artifacts={[]} missingArtifacts={['generatedJava']} />);
      expect(screen.getByText('Missing artifact records')).toBeDefined();
      expect(screen.getByText('generatedJava')).toBeDefined();
      expect(screen.getByText('No run artifacts available.')).toBeDefined();
    });

    it('moves artifact focus with keyboard navigation', () => {
      const artifacts = [
        {
          path: 'artifacts/source.cbl',
          name: 'art1',
          kind: 'source',
          byteSize: 1234,
          sha256: 'hash123',
          createdBy: 'system',
          createdAt: '2026-05-15T12:00:00Z',
        },
        {
          path: 'artifacts/build.log',
          name: 'art2',
          kind: 'log',
          byteSize: 42,
          sha256: 'hash456',
          createdBy: 'runner',
          createdAt: '2026-05-15T12:01:00Z',
        },
      ];

      render(<RunArtifactsPanel artifacts={artifacts} />);
      const firstArtifact = screen.getByRole('option', { name: /artifacts\/source\.cbl/i });
      fireEvent.keyDown(firstArtifact, { key: 'ArrowDown' });
      expect(screen.getByRole('option', { name: /artifacts\/build\.log/i, selected: true })).toBeDefined();
      expect(screen.getAllByText('hash456').length).toBeGreaterThan(0);
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
            diagnostics: [
              {
                severity: 'warning',
                code: 'gen-open-assumption',
                message: 'fallback path used',
                line: 4,
                originStep: 'generate-java'
              }
            ],
            artifactRef: {
              sha256: 'aaa',
              path: 'artifacts/generated.json'
            }
          },
          generatedFiles: {
            missingArtifacts: ['FilesMiss']
          },
          buildTest: {
            status: 'compile-failed',
            classification: 'compile-error',
            diagnostics: [
              {
                severity: 'error',
                code: 'javac-syntax',
                message: 'missing semicolon',
                line: 12,
                column: 7,
                filePath: 'src/main/java/P1.java',
                sourceKind: 'generated_java'
              }
            ],
            generatedArtifactRef: {
              sha256: 'bbb',
              path: 'artifacts/build-test.json'
            }
          },
          evidence: {
            status: 'incomplete',
            generatedArtifactRef: {
              sha256: 'ccc',
              path: 'artifacts/evidence.json'
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
      // Studio-IDE-5 (#244): typed diagnostics now render in a table.
      // Severity/file/line/code/message appear in their own cells.
      expect(screen.getByText('gen-open-assumption')).toBeDefined();
      expect(screen.getByText('fallback path used')).toBeDefined();
      expect(screen.getByText('javac-syntax')).toBeDefined();
      expect(screen.getByText('missing semicolon')).toBeDefined();
      expect(screen.getByText('src/main/java/P1.java')).toBeDefined();
      // The line column shows the bare integer.
      expect(screen.getAllByText('12').length).toBeGreaterThan(0);
      expect(screen.getAllByText('4').length).toBeGreaterThan(0);
      expect(screen.getByText('The evidence pack is missing required artifacts')).toBeDefined();
      expect(screen.getByText('artifact endpoint failed')).toBeDefined();
      expect(screen.getByText('Generated Java, build/test, and evidence do not reference the same artifact hash')).toBeDefined();
    });

    it('navigates only diagnostics with a concrete editor target', () => {
      const jumpableDiagnostic = {
        severity: 'error',
        code: 'JUMP',
        message: 'jumpable diagnostic',
        line: 9,
        column: 3,
        filePath: 'src/main/java/App.java',
        sourceKind: 'generated_java',
      };
      useTransformationRunMock.mockReturnValue({
        state: {
          ...mockState,
          phase: 'completed',
          generated: {
            status: 'generated',
            diagnostics: [
              jumpableDiagnostic,
              {
                severity: 'warning',
                code: 'RUN',
                message: 'run-level diagnostic',
                line: 3,
                sourceKind: 'build',
              },
            ],
          },
          buildTest: null,
        },
      });

      render(<ProblemsPanel emptyState={{ title: 'Empty', message: 'Message' }} />);

      const jumpableRow = screen.getByLabelText(
        'error JUMP at src/main/java/App.java:9',
      );
      const runLevelRow = screen.getByLabelText('warning RUN at —:3');

      expect(jumpableRow).toHaveAttribute('tabindex', '0');
      expect(runLevelRow).toHaveAttribute('tabindex', '-1');

      fireEvent.click(jumpableRow);
      fireEvent.keyDown(jumpableRow, { key: 'Enter' });
      fireEvent.keyDown(jumpableRow, { key: ' ' });
      expect(navigateToDiagnosticMock).toHaveBeenCalledTimes(3);
      expect(navigateToDiagnosticMock).toHaveBeenCalledWith(jumpableDiagnostic);

      fireEvent.click(runLevelRow);
      fireEvent.keyDown(runLevelRow, { key: 'Enter' });
      fireEvent.keyDown(runLevelRow, { key: ' ' });
      expect(navigateToDiagnosticMock).toHaveBeenCalledTimes(3);
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
