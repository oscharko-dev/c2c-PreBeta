"use client";

import { useState } from "react";

import { apiClient } from "@/lib/apiClient";
import type { OutputChangeExplanationResponse } from "@/types/api";
import { StatusChip } from "../ui/StatusChip";

export function OutputChangeExplanationPanel({
  currentRunId,
  previousRunId,
}: {
  currentRunId: string | null;
  previousRunId: string | null;
}) {
  const [state, setState] = useState<{
    loading: boolean;
    data: OutputChangeExplanationResponse | null;
    error: string | null;
  }>({
    loading: false,
    data: null,
    error: null,
  });

  const requestExplanation = async (includeAiSummary = false) => {
    if (!currentRunId || !previousRunId) {
      setState({
        loading: false,
        data: null,
        error:
          "A previous completed run is required before output changes can be explained.",
      });
      return;
    }
    setState((previous) => ({
      loading: true,
      data: includeAiSummary ? previous.data : null,
      error: null,
    }));
    const result = await apiClient.getOutputChangeExplanation(currentRunId, {
      previousRunId,
      includeAiSummary,
    });
    if (!result.ok) {
      setState((previous) => ({
        loading: false,
        data: previous.data,
        error: result.message,
      }));
      return;
    }
    setState({
      loading: false,
      data: result.data,
      error: null,
    });
  };

  const aiAvailable =
    state.data?.status === "available" &&
    state.data.aiSummary.status !== "available";

  return (
    <section className="rounded border border-line-2 bg-bg-1 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium text-text">
            Why did this output change?
          </h3>
          <p className="mt-1 text-xs text-text-dim">
            Compare the current parity run against the preserved previous run
            using deterministic evidence first, then optionally request an
            advisory AI summary grounded in that evidence.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="rounded border border-line bg-bg-0 px-3 py-2 text-xs font-medium text-text hover:bg-bg-2 disabled:cursor-not-allowed disabled:opacity-60"
            onClick={() => void requestExplanation(false)}
            disabled={state.loading || !currentRunId || !previousRunId}
          >
            {state.loading ? "Loading..." : "Explain output change"}
          </button>
          {aiAvailable ? (
            <button
              type="button"
              className="rounded border border-line bg-bg-0 px-3 py-2 text-xs font-medium text-text hover:bg-bg-2 disabled:cursor-not-allowed disabled:opacity-60"
              onClick={() => void requestExplanation(true)}
              disabled={state.loading}
            >
              Generate AI summary
            </button>
          ) : null}
        </div>
      </div>

      {state.error ? (
        <div className="mt-4 rounded border border-warn/20 bg-warn-soft px-3 py-2 text-xs text-warn">
          {state.error}
        </div>
      ) : null}

      {state.data ? (
        <div className="mt-4 space-y-4" data-testid="output-change-explanation">
          <div className="flex flex-wrap items-center gap-2">
            <StatusChip
              variant={
                state.data.status === "available"
                  ? state.data.determination === "single_change"
                    ? "success"
                    : state.data.determination === "multiple_changes"
                      ? "warning"
                      : "neutral"
                  : "warning"
              }
            />
            <p className="text-sm text-text">{state.data.summary}</p>
          </div>

          {state.data.outputDelta ? (
            <div className="rounded border border-line bg-bg-0 p-3">
              <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-text-dim">
                Output delta
              </div>
              <p className="text-xs text-text-dim">
                {state.data.outputDelta.addedLineCount} added lines and{" "}
                {state.data.outputDelta.removedLineCount} removed lines across
                the selected runs.
              </p>
              <div className="mt-3 space-y-1 font-mono text-xs text-text">
                {state.data.outputDelta.excerpt.map((line, index) => (
                  <div key={`${line.kind}:${index}`}>
                    <span className="mr-2 text-text-dim">
                      {line.kind === "added"
                        ? "+"
                        : line.kind === "removed"
                          ? "-"
                          : " "}
                    </span>
                    <span>{line.content}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <div className="grid gap-3 md:grid-cols-2">
            {state.data.categories.map((entry) => (
              <div
                key={entry.category}
                className="rounded border border-line bg-bg-0 p-3"
              >
                <div className="flex items-center gap-2">
                  <StatusChip variant={entry.changed ? "warning" : "neutral"} />
                  <h4 className="text-sm font-medium text-text">
                    {entry.title}
                  </h4>
                </div>
                <p className="mt-2 text-xs text-text-dim">{entry.detail}</p>
                {entry.evidenceLinks.length > 0 ? (
                  <div className="mt-3 space-y-2">
                    {entry.evidenceLinks.map((link) => (
                      <div key={link.label} className="text-xs text-text-dim">
                        <div className="font-medium text-text">
                          {link.label}
                        </div>
                        <div className="font-mono">
                          {link.currentRef?.sha256
                            ? `Current: ${link.currentRef.sha256.slice(0, 12)}`
                            : null}
                        </div>
                        <div className="font-mono">
                          {link.previousRef?.sha256
                            ? `Previous: ${link.previousRef.sha256.slice(0, 12)}`
                            : null}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ))}
          </div>

          <div className="rounded border border-line bg-bg-0 p-3">
            <div className="mb-2 flex items-center gap-2">
              <StatusChip
                variant={
                  state.data.aiSummary.status === "available"
                    ? "success"
                    : "neutral"
                }
              />
              <h4 className="text-sm font-medium text-text">
                {state.data.aiSummary.label}
              </h4>
            </div>
            <p className="text-xs text-text-dim">
              {state.data.aiSummary.groundingLabel}
            </p>
            {state.data.aiSummary.status === "available" ? (
              <p className="mt-3 text-sm text-text">
                {state.data.aiSummary.explanation}
              </p>
            ) : (
              <p className="mt-3 text-xs text-text-dim">
                The advisory AI summary is unavailable until deterministic
                evidence is ready and the Model Gateway can serve the request.
              </p>
            )}
          </div>
        </div>
      ) : null}
    </section>
  );
}
