import { render, screen, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentActivityPanel } from '../../../src/components/run/AgentActivityPanel';
import { RunWorkflowView } from '../../../src/types/api';

const baseState = {
  phase: 'running' as const,
  runId: 'run-1',
  orchestratorRunId: 'orch-1',
  programId: 'PROG01',
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
  useTransformationRun: vi.fn(() => ({ state: baseState })),
}));

function makeWorkflow(overrides: Partial<RunWorkflowView> = {}): RunWorkflowView {
  return {
    runId: 'run-1',
    programId: 'PROG01',
    mode: 'live',
    productMode: 'live',
    source: 'live',
    state: 'agent_running',
    activeStep: 'generate-java',
    activeAgent: 'transformation_agent',
    agentAttemptCount: 1,
    repairBudget: { limit: 3, used: 0, remaining: 3 },
    repairAttempts: [],
    finalClassification: null,
    failureCode: null,
    failureMessage: null,
    generatedJavaRef: null,
    buildTestResultRef: null,
    evidencePackRef: null,
    ...overrides,
  };
}

describe('AgentActivityPanel', () => {
  let useTransformationRunMock: any;

  beforeEach(async () => {
    vi.resetAllMocks();
    const mod = await import('../../../src/stores/transformationRun');
    useTransformationRunMock = mod.useTransformationRun;
  });

  it('renders the idle empty state when no run is active', () => {
    useTransformationRunMock.mockReturnValue({ state: { ...baseState, phase: 'idle' } });
    render(<AgentActivityPanel emptyState={{ title: 'No agent activity yet', message: 'Run a transformation.' }} />);
    expect(screen.getByTestId('agent-activity-idle')).toBeDefined();
    expect(screen.getByText('No agent activity yet')).toBeDefined();
  });

  it('shows a pending notice when workflow contract has not yet arrived', () => {
    useTransformationRunMock.mockReturnValue({ state: { ...baseState, phase: 'running', workflow: null } });
    render(<AgentActivityPanel emptyState={{ title: 'Empty', message: 'Empty' }} />);
    expect(screen.getByTestId('agent-activity-pending')).toBeDefined();
  });

  it('renders active agent label, description, attempt count, and active step', () => {
    useTransformationRunMock.mockReturnValue({
      state: {
        ...baseState,
        phase: 'running',
        workflow: makeWorkflow({
          agentAttemptCount: 2,
          generatedJavaRef: { sha256: 'a'.repeat(64), byteSize: 128, kind: 'generated-java' },
        }),
      },
    });
    render(<AgentActivityPanel emptyState={{ title: 'Empty', message: 'Empty' }} />);
    const status = screen.getByTestId('agent-activity-workflow-status');
    expect(within(status).getByText('agent_running')).toBeDefined();
    expect(within(status).getByText(/no invocation record yet/)).toBeDefined();
    const artifactRefs = screen.getByTestId('agent-activity-artifact-refs');
    expect(within(artifactRefs).getByText(/generated-java/)).toBeDefined();
    const activeAgent = screen.getByTestId('agent-activity-active-agent');
    expect(within(activeAgent).getByText('Transformation Agent')).toBeDefined();
    expect(within(activeAgent).getByText(/generate-java/)).toBeDefined();
    expect(screen.getByTestId('agent-activity-attempt-count').textContent).toContain('2 agent attempts so far');
  });

  it('renders the repair budget bar and exhausted state', () => {
    useTransformationRunMock.mockReturnValue({
      state: {
        ...baseState,
        phase: 'running',
        workflow: makeWorkflow({ repairBudget: { limit: 3, used: 3, remaining: 0 } }),
      },
    });
    render(<AgentActivityPanel emptyState={{ title: 'Empty', message: 'Empty' }} />);
    const budget = screen.getByTestId('agent-activity-repair-budget');
    expect(within(budget).getByText(/3 \/ 3 attempts used/)).toBeDefined();
    expect(within(budget).getByText(/0 remaining/)).toBeDefined();
  });

  it('lists repair attempts with decision, breadcrumbs, and rationale', () => {
    useTransformationRunMock.mockReturnValue({
      state: {
        ...baseState,
        phase: 'running',
        workflow: makeWorkflow({
          activeAgent: 'verification_repair_agent',
          repairAttempts: [
            {
              attemptNumber: 1,
              repairDecision: 'propose_candidate',
              failureCategory: 'oracle_mismatch',
              hasModelInvocation: true,
              hasRepairInput: true,
              hasJavaCandidate: true,
              rationale: 'Retrying with adjusted accumulator logic.',
            },
            {
              attemptNumber: 2,
              repairDecision: 'escalate',
              failureCategory: null,
              hasModelInvocation: false,
              hasRepairInput: false,
              hasJavaCandidate: false,
            },
          ],
        }),
      },
    });
    render(<AgentActivityPanel emptyState={{ title: 'Empty', message: 'Empty' }} />);
    const list = screen.getByTestId('agent-activity-repair-attempts');
    expect(screen.getByTestId('agent-activity-workflow-status').textContent).toContain('1 invocation record observed');
    expect(within(list).getByText('Repair attempts (2)')).toBeDefined();
    expect(within(list).getByText('Attempt #1')).toBeDefined();
    expect(within(list).getByText('Proposed candidate')).toBeDefined();
    expect(within(list).getByText('oracle_mismatch')).toBeDefined();
    expect(within(list).getByText(/Retrying with adjusted accumulator logic/)).toBeDefined();
    expect(within(list).getByText('Attempt #2')).toBeDefined();
    expect(within(list).getByText('Escalated')).toBeDefined();
  });

  it('renders the BFF failure verdict with closed-set label and description', () => {
    useTransformationRunMock.mockReturnValue({
      state: {
        ...baseState,
        phase: 'failed',
        workflow: makeWorkflow({
          activeAgent: null,
          finalClassification: 'blocked',
          failureCode: 'model_gateway_unavailable',
          failureMessage: 'gateway returned 502',
        }),
      },
    });
    render(<AgentActivityPanel emptyState={{ title: 'Empty', message: 'Empty' }} />);
    const failure = screen.getByTestId('agent-activity-final-failure');
    expect(within(failure).getByText('Model Gateway unavailable')).toBeDefined();
    expect(within(failure).getByText(/Model Gateway is not reachable/)).toBeDefined();
    expect(within(failure).getByText('gateway returned 502')).toBeDefined();
  });

  it('renders a success verdict when finalClassification is success', () => {
    useTransformationRunMock.mockReturnValue({
      state: {
        ...baseState,
        phase: 'completed',
        workflow: makeWorkflow({
          activeAgent: null,
          finalClassification: 'success',
        }),
      },
    });
    render(<AgentActivityPanel emptyState={{ title: 'Empty', message: 'Empty' }} />);
    expect(screen.getByTestId('agent-activity-final-success')).toBeDefined();
  });
});
