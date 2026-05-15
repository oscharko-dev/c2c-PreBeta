import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { HarnessTimeline } from '../src/components/observability/HarnessTimeline';
import { ExperienceLearningPanel } from '../src/components/observability/ExperienceLearningPanel';
import { ModelGatewayPanel } from '../src/components/observability/ModelGatewayPanel';
import * as transformationRun from '../src/stores/transformationRun';

// Mock the hook
vi.mock('../src/stores/transformationRun', () => ({
  useTransformationRun: vi.fn(),
}));

describe('Observability Surfaces', () => {
  it('renders events timeline from RunEventsView', () => {
    vi.mocked(transformationRun.useTransformationRun).mockReturnValue({
      state: {
        harnessReady: { status: 'ok' },
        events: {
          runId: 'r1',
          programId: 'p1',
          mode: 'live',
          productMode: 'live',
          events: [
            { type: 'test-event', status: 'ok', message: 'all good', createdAt: '2026-05-15T00:00:00Z' }
          ]
        }
      } as any,
      startTransform: vi.fn(),
      setState: vi.fn()
    });

    render(<HarnessTimeline />);
    expect(screen.getByText('test-event')).toBeDefined();
    expect(screen.getByText('all good')).toBeDefined();
  });

  it('renders Experience Learning unavailable state', () => {
    vi.mocked(transformationRun.useTransformationRun).mockReturnValue({
      state: {
        phase: 'completed',
        runId: 'r1',
        experience: { productMode: 'unavailable' }
      } as any,
      startTransform: vi.fn(),
      setState: vi.fn()
    });

    render(<ExperienceLearningPanel />);
    expect(screen.getByText(/Experience Learning unavailable for this run/i)).toBeDefined();
  });

  it('renders Experience Learning available state', () => {
    vi.mocked(transformationRun.useTransformationRun).mockReturnValue({
      state: {
        phase: 'completed',
        runId: 'r1',
        experience: {
          productMode: 'live',
          summary: 'Learned something new',
          observationPolicy: 'strict',
          detectedPatterns: ['pattern A'],
          artifactRefs: ['urn:test']
        }
      } as any,
      startTransform: vi.fn(),
      setState: vi.fn()
    });

    render(<ExperienceLearningPanel />);
    expect(screen.getByText('Learned something new')).toBeDefined();
    expect(screen.getByText('strict')).toBeDefined();
    expect(screen.getByText('pattern A')).toBeDefined();
    expect(screen.getByText('urn:test')).toBeDefined();
  });

  it('renders Model Gateway governance summary and confirms no Foundry participation in deterministic W0', () => {
    vi.mocked(transformationRun.useTransformationRun).mockReturnValue({
      state: {
        modelGatewayHealth: { status: 'unavailable' }
      } as any,
      startTransform: vi.fn(),
      setState: vi.fn()
    });

    render(<ModelGatewayPanel />);
    expect(screen.getByText(/Model Gateway governance summary unavailable/i)).toBeDefined();
    expect(screen.getByText(/No Foundry or LLM participation was required or performed for this run/i)).toBeDefined();
  });
});
