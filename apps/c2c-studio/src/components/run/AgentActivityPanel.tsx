'use client';

import { useTransformationRun } from '../../stores/transformationRun';
import { StatusChip } from '../ui/StatusChip';
import {
  ACTIVE_AGENT_DESCRIPTIONS,
  ACTIVE_AGENT_LABELS,
  REPAIR_DECISION_LABELS,
  W02_ERROR_DESCRIPTIONS,
  W02_ERROR_LABELS,
  repairBudgetText,
} from './agentActivity';
import { RepairAttemptSummary, RepairBudget, W02ActiveAgent } from '../../types/api';

interface AgentActivityPanelProps {
  emptyState: { title: string; message: string };
}

export function AgentActivityPanel({ emptyState }: AgentActivityPanelProps) {
  const { state } = useTransformationRun();

  if (state.phase === 'idle') {
    return (
      <div className="p-4 space-y-2 text-sm" data-testid="agent-activity-idle">
        <p className="font-medium text-text">{emptyState.title}</p>
        <p className="text-text-dim">{emptyState.message}</p>
      </div>
    );
  }

  const workflow = state.workflow;

  if (!workflow) {
    return (
      <div className="p-4 text-sm text-text-dim" data-testid="agent-activity-pending">
        Waiting for the orchestrator to publish the W0.2 workflow contract…
      </div>
    );
  }

  const {
    activeAgent,
    activeStep,
    agentAttemptCount,
    repairBudget,
    repairAttempts,
    finalClassification,
    failureCode,
    failureMessage,
  } = workflow;

  return (
    <section
      className="flex flex-col gap-4 p-4 text-sm"
      aria-label="Agent activity"
      data-testid="agent-activity-panel"
    >
      <ActiveAgentRow activeAgent={activeAgent} activeStep={activeStep} attemptCount={agentAttemptCount} />
      <RepairBudgetRow budget={repairBudget} />
      <RepairAttemptsList attempts={repairAttempts} />
      <FailureRow
        finalClassification={finalClassification}
        failureCode={failureCode}
        failureMessage={failureMessage}
      />
    </section>
  );
}

function ActiveAgentRow({
  activeAgent,
  activeStep,
  attemptCount,
}: {
  activeAgent: W02ActiveAgent | null;
  activeStep: string | null;
  attemptCount: number;
}) {
  const label = activeAgent ? ACTIVE_AGENT_LABELS[activeAgent] : 'No active agent';
  const description = activeAgent ? ACTIVE_AGENT_DESCRIPTIONS[activeAgent] : 'No agent is currently running.';
  return (
    <div
      className="rounded border border-line-2 bg-bg-2 p-3"
      data-testid="agent-activity-active-agent"
    >
      <div className="flex items-center gap-2">
        <StatusChip variant={activeAgent ? 'pending' : 'neutral'} pulse={Boolean(activeAgent)} />
        <span className="font-medium text-text">{label}</span>
        {activeStep ? (
          <span className="text-xs text-text-dim" data-testid="agent-activity-active-step">
            · step: <span className="font-mono">{activeStep}</span>
          </span>
        ) : null}
      </div>
      <p className="mt-1 text-xs text-text-dim">{description}</p>
      <p className="mt-1 text-xs text-text-dim" data-testid="agent-activity-attempt-count">
        {attemptCount} agent {attemptCount === 1 ? 'attempt' : 'attempts'} so far
      </p>
    </div>
  );
}

function RepairBudgetRow({ budget }: { budget: RepairBudget | null }) {
  if (!budget) {
    return (
      <div
        className="rounded border border-line-2 bg-bg-2 p-3 text-xs text-text-dim"
        data-testid="agent-activity-repair-budget"
      >
        Repair budget not yet allocated.
      </div>
    );
  }

  const exhausted = budget.remaining === 0;
  const ratio = budget.limit > 0 ? Math.min(1, budget.used / budget.limit) : 0;

  return (
    <div
      className="rounded border border-line-2 bg-bg-2 p-3"
      data-testid="agent-activity-repair-budget"
    >
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium text-text">Repair budget</span>
        <span className={exhausted ? 'text-error' : 'text-text-dim'}>
          {repairBudgetText(budget.used, budget.limit)} · {budget.remaining} remaining
        </span>
      </div>
      <div
        className="mt-2 h-1.5 w-full overflow-hidden rounded bg-bg-3"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={budget.limit}
        aria-valuenow={budget.used}
        aria-label="Repair attempts used"
      >
        <div
          className={exhausted ? 'h-full bg-error' : 'h-full bg-accent'}
          style={{ width: `${Math.round(ratio * 100)}%` }}
        />
      </div>
    </div>
  );
}

function RepairAttemptsList({ attempts }: { attempts: RepairAttemptSummary[] }) {
  if (attempts.length === 0) {
    return (
      <div
        className="rounded border border-line-2 bg-bg-2 p-3 text-xs text-text-dim"
        data-testid="agent-activity-repair-attempts-empty"
      >
        No repair attempts yet.
      </div>
    );
  }

  return (
    <div
      className="rounded border border-line-2 bg-bg-2"
      data-testid="agent-activity-repair-attempts"
    >
      <div className="border-b border-line-2 px-3 py-2 text-xs font-medium text-text">
        Repair attempts ({attempts.length})
      </div>
      <ul className="divide-y divide-line-2">
        {attempts.map((attempt) => (
          <li
            key={attempt.attemptNumber}
            className="space-y-1 px-3 py-2 text-xs"
            data-testid={`agent-activity-repair-attempt-${attempt.attemptNumber}`}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-text">Attempt #{attempt.attemptNumber}</span>
              <span className="rounded bg-bg-3 px-1.5 py-0.5 font-mono text-[10px] text-text-dim">
                {REPAIR_DECISION_LABELS[attempt.repairDecision]}
              </span>
              {attempt.failureCategory ? (
                <span className="rounded bg-bg-3 px-1.5 py-0.5 font-mono text-[10px] text-warn">
                  {attempt.failureCategory}
                </span>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-3 text-text-dim">
              <Breadcrumb label="model invoked" active={attempt.hasModelInvocation} />
              <Breadcrumb label="repair input" active={attempt.hasRepairInput} />
              <Breadcrumb label="java candidate" active={attempt.hasJavaCandidate} />
            </div>
            {attempt.rationale ? (
              <p className="text-text-dim italic">{attempt.rationale}</p>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Breadcrumb({ label, active }: { label: string; active: boolean }) {
  return (
    <span className="inline-flex items-center gap-1">
      <StatusChip variant={active ? 'success' : 'neutral'} />
      <span>{label}</span>
    </span>
  );
}

function FailureRow({
  finalClassification,
  failureCode,
  failureMessage,
}: {
  finalClassification: string | null;
  failureCode: keyof typeof W02_ERROR_LABELS | null;
  failureMessage: string | null;
}) {
  if (!failureCode && !failureMessage && !finalClassification) {
    return null;
  }
  if (finalClassification === 'success') {
    return (
      <div
        className="rounded border border-success/40 bg-success/10 p-3 text-xs text-success"
        data-testid="agent-activity-final-success"
      >
        Final classification: success
      </div>
    );
  }

  const label = failureCode ? W02_ERROR_LABELS[failureCode] : finalClassification ?? 'Run did not succeed';
  const description = failureCode ? W02_ERROR_DESCRIPTIONS[failureCode] : failureMessage ?? null;

  return (
    <div
      className="rounded border border-error/40 bg-error/10 p-3 text-xs"
      data-testid="agent-activity-final-failure"
    >
      <div className="font-medium text-error">{label}</div>
      {description ? <p className="mt-1 text-text-dim">{description}</p> : null}
      {failureMessage && failureMessage !== description ? (
        <p className="mt-1 font-mono text-[11px] text-text-dim">{failureMessage}</p>
      ) : null}
    </div>
  );
}
