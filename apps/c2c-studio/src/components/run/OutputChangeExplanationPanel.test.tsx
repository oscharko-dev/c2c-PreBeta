import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { OutputChangeExplanationPanel } from "./OutputChangeExplanationPanel";
import { apiClient } from "@/lib/apiClient";
import type { OutputChangeExplanationResponse } from "@/types/api";

afterEach(() => {
  vi.restoreAllMocks();
});

function explanation(
  overrides: Partial<OutputChangeExplanationResponse> = {},
): OutputChangeExplanationResponse {
  return {
    schemaVersion: "v0",
    status: "available",
    currentRunId: "run-current",
    previousRunId: "run-previous",
    programId: "CASE01",
    currentTrustCaseId: "CASE01-DEFAULT",
    previousTrustCaseId: "CASE01-DEFAULT",
    determination: "single_change",
    primaryCategory: "repair_patch",
    summary: "The output change is most directly explained by repair patch.",
    categories: [
      {
        category: "repair_patch",
        changed: true,
        title: "Repair patch changed",
        detail: "Repair-decision lineage differs between the selected runs.",
        evidenceLinks: [
          {
            label: "Repair decision reference",
            currentRef: { sha256: "c".repeat(64) },
            previousRef: { sha256: "d".repeat(64) },
          },
        ],
      },
    ],
    outputDelta: {
      changed: true,
      addedLineCount: 1,
      removedLineCount: 1,
      excerpt: [
        { kind: "removed", content: "OLD" },
        { kind: "added", content: "NEW" },
      ],
      currentNormalizedOutputRef: { sha256: "a".repeat(64) },
      previousNormalizedOutputRef: { sha256: "b".repeat(64) },
      currentComparisonDiffRef: null,
      previousComparisonDiffRef: null,
    },
    evidenceLinks: [],
    aiSummary: {
      status: "unavailable",
      label: "AI-assisted explanation",
      groundingLabel: "Grounded in deterministic evidence",
      unavailableReason: "insufficient_evidence",
    },
    ...overrides,
  };
}

describe("OutputChangeExplanationPanel", () => {
  it("renders deterministic output-change analysis", async () => {
    vi.spyOn(apiClient, "getOutputChangeExplanation").mockResolvedValue({
      ok: true,
      data: explanation(),
    });
    const user = userEvent.setup();
    render(
      <OutputChangeExplanationPanel
        currentRunId="run-current"
        previousRunId="run-previous"
      />,
    );
    await user.click(
      screen.getByRole("button", { name: /Explain output change/i }),
    );
    await screen.findByTestId("output-change-explanation");
    expect(screen.getByText(/Repair patch changed/i)).toBeInTheDocument();
    expect(screen.getByText("OLD")).toBeInTheDocument();
    expect(screen.getByText("NEW")).toBeInTheDocument();
    expect(screen.getByText(/Repair decision reference/i)).toBeInTheDocument();
    expect(screen.getByText(/Current: cccccccccccc/i)).toBeInTheDocument();
    expect(screen.getByText(/Previous: dddddddddddd/i)).toBeInTheDocument();
  });

  it("renders unavailable advisory text when AI summary is not ready", async () => {
    vi.spyOn(apiClient, "getOutputChangeExplanation").mockResolvedValue({
      ok: true,
      data: explanation(),
    });
    const user = userEvent.setup();
    render(
      <OutputChangeExplanationPanel
        currentRunId="run-current"
        previousRunId="run-previous"
      />,
    );
    await user.click(
      screen.getByRole("button", { name: /Explain output change/i }),
    );
    await screen.findByText(/Grounded in deterministic evidence/i);
    expect(
      screen.getByText(/advisory AI summary is unavailable/i),
    ).toBeInTheDocument();
  });

  it("requests and renders the AI summary when available", async () => {
    const spy = vi
      .spyOn(apiClient, "getOutputChangeExplanation")
      .mockResolvedValueOnce({
        ok: true,
        data: explanation(),
      })
      .mockResolvedValueOnce({
        ok: true,
        data: explanation({
          aiSummary: {
            status: "available",
            label: "AI-assisted explanation",
            groundingLabel: "Grounded in deterministic evidence",
            explanation:
              "The repaired Java candidate changed the observed output.",
            modelInvocationRef: "inv-1",
            ledgerRef: "urn:ledger:1",
          },
        }),
      });
    const user = userEvent.setup();
    render(
      <OutputChangeExplanationPanel
        currentRunId="run-current"
        previousRunId="run-previous"
      />,
    );
    await user.click(
      screen.getByRole("button", { name: /Explain output change/i }),
    );
    await screen.findByRole("button", { name: /Generate AI summary/i });
    await user.click(
      screen.getByRole("button", { name: /Generate AI summary/i }),
    );
    await screen.findByText(/repaired Java candidate changed/i);
    await waitFor(() => {
      expect(spy).toHaveBeenNthCalledWith(2, "run-current", {
        previousRunId: "run-previous",
        includeAiSummary: true,
      });
    });
  });

  it("preserves deterministic analysis when the AI summary request fails", async () => {
    vi.spyOn(apiClient, "getOutputChangeExplanation")
      .mockResolvedValueOnce({
        ok: true,
        data: explanation(),
      })
      .mockResolvedValueOnce({
        ok: false,
        message: "Model gateway request failed.",
      });
    const user = userEvent.setup();
    render(
      <OutputChangeExplanationPanel
        currentRunId="run-current"
        previousRunId="run-previous"
      />,
    );
    await user.click(
      screen.getByRole("button", { name: /Explain output change/i }),
    );
    await screen.findByRole("button", { name: /Generate AI summary/i });
    await user.click(
      screen.getByRole("button", { name: /Generate AI summary/i }),
    );
    await screen.findByText(/Model gateway request failed/i);
    expect(screen.getByTestId("output-change-explanation")).toBeInTheDocument();
    expect(screen.getByText(/Repair patch changed/i)).toBeInTheDocument();
  });
});
