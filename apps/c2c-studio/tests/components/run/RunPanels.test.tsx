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
  summary: null,
  generated: null,
  generatedFiles: null,
  buildTest: null,
  evidence: null,
  events: null,
  artifacts: null,
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
      expect(screen.getByText('skipped-no-execution')).toBeDefined();
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
            expectedOutput: 'Line 1\\nLine 2',
            actualOutput: 'Line A\\nLine B',
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
  });

  describe('EvidencePackPanel', () => {
    it('renders evidence complete correctly', () => {
      useTransformationRunMock.mockReturnValue({
        state: {
          ...mockState,
          phase: 'completed',
          evidence: {
            status: 'complete',
            packId: 'pack-123',
            manifestUri: 'air://manifest'
          }
        }
      });
      render(<EvidencePackPanel emptyState={{ title: 'Empty', message: 'Message' }} />);
      expect(screen.getByText('Evidence Pack Complete')).toBeDefined();
      expect(screen.getByText('pack-123')).toBeDefined();
      expect(screen.getByText('air://manifest')).toBeDefined();
      expect(screen.getByText('All required artifacts are present.')).toBeDefined();
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
  });

  describe('ProblemsPanel', () => {
    it('derives issues from features, missing artifacts, failed statuses, and hash mismatches', () => {
      useTransformationRunMock.mockReturnValue({
        state: {
          ...mockState,
          phase: 'completed',
          generated: {
            unsupportedFeatures: ['GOTO', 'ALTER'],
            missingArtifacts: ['GenMiss']
          },
          buildTest: {
            status: 'compile-failed',
            classification: 'compile-error'
          },
          evidence: {
            status: 'incomplete'
          }
        }
      });
      render(<ProblemsPanel emptyState={{ title: 'Empty', message: 'Message' }} />);
      expect(screen.getByText('GOTO')).toBeDefined();
      expect(screen.getByText('ALTER')).toBeDefined();
      expect(screen.getByText('GenMiss')).toBeDefined();
      expect(screen.getByText('compile-failed')).toBeDefined();
      expect(screen.getByText('compile-error')).toBeDefined();
      expect(screen.getByText('The evidence pack is missing required artifacts')).toBeDefined();
    });
  });
});
