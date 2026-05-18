// Studio-IDE-10 (#249): tests for the Editor-Assist side panel.
//
// Coverage:
//   - Success rendering: explanation markdown is rendered (sanitised),
//     ledger/model/assist refs are copy-to-clipboard.
//   - Sanitiser boundary: an injected `<script>` payload in the
//     explanation is rendered as text and never executes (DOMPurify
//     stripped it before React mounted the HTML).
//   - Each of the five closed-set error codes renders its distinct
//     branch with the expected affordance (retry button for gateway /
//     timeout, policy chip for policy_denied, etc.).
//   - Retry button fires `onRetry` exactly once.
//   - Preview-redaction expander lists the matched pattern ids.
//   - Keyboard reachability: the close button and copy chips are
//     focusable via `Tab`.

import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  EDITOR_ASSIST_SCHEMA_VERSION,
  type EditorAssistErrorCode,
  type EditorAssistRequest,
  type EditorAssistResult,
} from "@/types/editor-assist";

import { EditorAssistSidePanel } from "./EditorAssistSidePanel";

const SAMPLE_REQUEST: EditorAssistRequest = {
  schemaVersion: EDITOR_ASSIST_SCHEMA_VERSION,
  sessionId: "session-abc",
  tenantId: "default",
  userId: "local",
  runId: null,
  sourceHash:
    "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
  region: {
    filePath: "PAYROLL.cbl",
    sourceKind: "cobol",
    startLine: 12,
    endLine: 24,
  },
  redactedBytes: "MOVE 1 TO X.",
  byteHash: "0000000000000000000000000000000000000000000000000000000000000000",
  studioRedactionMetadata: {
    studioRedactionProfileVersion: "v1.0.0",
    matchedPatternIds: ["field-name-class:customer-name", "ssn-us"],
  },
};

function successResult(overrides?: {
  explanation?: string;
  budget?: { limit: number; used: number; remaining: number };
}): EditorAssistResult {
  return {
    ok: true,
    data: {
      schemaVersion: EDITOR_ASSIST_SCHEMA_VERSION,
      explanation: overrides?.explanation ?? "**Bold** plain text.",
      modelInvocationRef: "model-inv-xyz-123",
      editorAssistRef: "assist-987-654",
      ledgerRef: "ledger-111-222",
      budgetSnapshot: overrides?.budget ?? {
        limit: 3,
        used: 1,
        remaining: 2,
      },
      redactionApplied: ["field-name-class:customer-name"],
    },
  };
}

function errorResult(
  errorCode: EditorAssistErrorCode,
  message: string,
  budget: { limit: number; used: number; remaining: number } | null = null,
): EditorAssistResult {
  return { ok: false, errorCode, message, budgetSnapshot: budget };
}

// Stub `navigator.clipboard.writeText` so the copy chips report
// success in jsdom. The spy doubles as an assertion target for
// "ledger refs are copyable" below.
let clipboardSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  clipboardSpy = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(globalThis.navigator, "clipboard", {
    configurable: true,
    value: { writeText: clipboardSpy },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("EditorAssistSidePanel — render gating", () => {
  it("renders nothing when open is false", () => {
    const { container } = render(
      <EditorAssistSidePanel
        open={false}
        request={SAMPLE_REQUEST}
        result={successResult()}
        onClose={() => {}}
        onRetry={() => {}}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when request is null", () => {
    const { container } = render(
      <EditorAssistSidePanel
        open
        request={null}
        result={null}
        onClose={() => {}}
        onRetry={() => {}}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders the in-flight status while result is null", () => {
    render(
      <EditorAssistSidePanel
        open
        request={SAMPLE_REQUEST}
        result={null}
        onClose={() => {}}
        onRetry={() => {}}
      />,
    );
    // Multiple role="status" elements exist (in-flight indicator + CopyChip
    // live regions). Find the one that carries the loading text.
    const statuses = screen.getAllByRole("status");
    const inFlight = statuses.find((el) =>
      /Requesting explanation/i.test(el.textContent ?? ""),
    );
    expect(inFlight).toBeDefined();
    expect(inFlight).toHaveTextContent(/Requesting explanation/i);
  });
});

describe("EditorAssistSidePanel — success path", () => {
  it("renders the file + line range header", () => {
    render(
      <EditorAssistSidePanel
        open
        request={SAMPLE_REQUEST}
        result={successResult()}
        onClose={() => {}}
        onRetry={() => {}}
      />,
    );
    const header = screen.getByTestId("editor-assist-side-panel-header");
    expect(header).toHaveTextContent("PAYROLL.cbl");
    expect(header).toHaveTextContent("12");
    expect(header).toHaveTextContent("24");
  });

  it("renders the explanation as sanitised HTML (bold preserved)", () => {
    render(
      <EditorAssistSidePanel
        open
        request={SAMPLE_REQUEST}
        result={successResult({ explanation: "This is **strong** text." })}
        onClose={() => {}}
        onRetry={() => {}}
      />,
    );
    const explanation = screen.getByTestId("editor-assist-explanation");
    expect(explanation.innerHTML.toLowerCase()).toContain(
      "<strong>strong</strong>",
    );
  });

  it("neutralises an injected <script> in the explanation", () => {
    const payload = "Safe text. <script>window.__pwned = true;</script> after.";
    render(
      <EditorAssistSidePanel
        open
        request={SAMPLE_REQUEST}
        result={successResult({ explanation: payload })}
        onClose={() => {}}
        onRetry={() => {}}
      />,
    );
    const explanation = screen.getByTestId("editor-assist-explanation");
    // DOMPurify must drop the script tag entirely; the script must
    // never execute. Render-text equality is sloppy because marked
    // wraps content in <p> — assert on the raw HTML.
    expect(explanation.innerHTML.toLowerCase()).not.toContain("<script");
    expect(explanation.innerHTML).not.toContain("window.__pwned");
    expect(
      (globalThis as unknown as { __pwned?: boolean }).__pwned,
    ).toBeUndefined();
  });

  it("renders ledger / model / assist copy chips and copies on click", async () => {
    render(
      <EditorAssistSidePanel
        open
        request={SAMPLE_REQUEST}
        result={successResult()}
        onClose={() => {}}
        onRetry={() => {}}
      />,
    );
    const footer = screen.getByTestId("editor-assist-side-panel-footer");
    const ledger = within(footer).getByRole("button", {
      name: /Copy ledger reference/i,
    });
    fireEvent.click(ledger);
    expect(clipboardSpy).toHaveBeenCalledWith("ledger-111-222");

    const model = within(footer).getByRole("button", {
      name: /Copy model invocation reference/i,
    });
    fireEvent.click(model);
    expect(clipboardSpy).toHaveBeenCalledWith("model-inv-xyz-123");

    const assist = within(footer).getByRole("button", {
      name: /Copy editor-assist reference/i,
    });
    fireEvent.click(assist);
    expect(clipboardSpy).toHaveBeenCalledWith("assist-987-654");
  });

  it("renders the source-hash copy chip with shortened display", () => {
    render(
      <EditorAssistSidePanel
        open
        request={SAMPLE_REQUEST}
        result={successResult()}
        onClose={() => {}}
        onRetry={() => {}}
      />,
    );
    const sourceHashBtn = screen.getByRole("button", {
      name: /Copy full source hash/i,
    });
    fireEvent.click(sourceHashBtn);
    expect(clipboardSpy).toHaveBeenCalledWith(SAMPLE_REQUEST.sourceHash);
  });

  it("renders redactionApplied chips", () => {
    render(
      <EditorAssistSidePanel
        open
        request={SAMPLE_REQUEST}
        result={successResult()}
        onClose={() => {}}
        onRetry={() => {}}
      />,
    );
    const footer = screen.getByTestId("editor-assist-side-panel-footer");
    expect(footer).toHaveTextContent("field-name-class:customer-name");
  });
});

describe("EditorAssistSidePanel — error branches", () => {
  it("renders the budget_exhausted branch", () => {
    render(
      <EditorAssistSidePanel
        open
        request={SAMPLE_REQUEST}
        result={errorResult(
          "budget_exhausted",
          "No more Explain calls available.",
          { limit: 3, used: 3, remaining: 0 },
        )}
        onClose={() => {}}
        onRetry={() => {}}
      />,
    );
    const alert = screen.getByTestId("editor-assist-error-budget");
    expect(alert).toHaveTextContent(/No more Explain calls/i);
    expect(alert.querySelector("a")?.getAttribute("href")).toBe(
      "./docs/editor-assist-budget.md",
    );
  });

  it("renders the policy_denied branch with a copy chip for the policy id", () => {
    render(
      <EditorAssistSidePanel
        open
        request={SAMPLE_REQUEST}
        result={errorResult("policy_denied", "policy-id-7771")}
        onClose={() => {}}
        onRetry={() => {}}
      />,
    );
    const alert = screen.getByTestId("editor-assist-error-policy");
    expect(alert).toHaveTextContent(/Policy declined/i);
    const copy = within(alert).getByRole("button", {
      name: /Copy policy id/i,
    });
    fireEvent.click(copy);
    expect(clipboardSpy).toHaveBeenCalledWith("policy-id-7771");
  });

  it("renders the gateway_unavailable branch with a working Retry button", () => {
    const onRetry = vi.fn();
    render(
      <EditorAssistSidePanel
        open
        request={SAMPLE_REQUEST}
        result={errorResult("gateway_unavailable", "Upstream gateway down.")}
        onClose={() => {}}
        onRetry={onRetry}
      />,
    );
    const alert = screen.getByTestId("editor-assist-error-gateway");
    expect(alert).toHaveTextContent(/gateway unavailable/i);
    const retry = within(alert).getByRole("button", { name: /Retry/i });
    fireEvent.click(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("renders the timeout branch with a working Retry button", () => {
    const onRetry = vi.fn();
    render(
      <EditorAssistSidePanel
        open
        request={SAMPLE_REQUEST}
        result={errorResult("timeout", "Deadline exceeded.")}
        onClose={() => {}}
        onRetry={onRetry}
      />,
    );
    const alert = screen.getByTestId("editor-assist-error-timeout");
    const retry = within(alert).getByRole("button", { name: /Retry/i });
    fireEvent.click(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("renders the invalid_region branch with a 'select smaller block' hint", () => {
    render(
      <EditorAssistSidePanel
        open
        request={SAMPLE_REQUEST}
        result={errorResult("invalid_region", "Selection was empty.")}
        onClose={() => {}}
        onRetry={() => {}}
      />,
    );
    const alert = screen.getByTestId("editor-assist-error-region");
    expect(alert).toHaveTextContent(/smaller block/i);
  });
});

describe("EditorAssistSidePanel — preview redaction + a11y", () => {
  it("lists matched pattern ids inside the Preview redaction expander", () => {
    render(
      <EditorAssistSidePanel
        open
        request={SAMPLE_REQUEST}
        result={successResult()}
        onClose={() => {}}
        onRetry={() => {}}
      />,
    );
    const preview = screen.getByTestId("editor-assist-preview-redaction");
    // The list is rendered inside <details>; jsdom exposes the children
    // regardless of the open state, which is good enough for assertion.
    expect(preview).toHaveTextContent("field-name-class:customer-name");
    expect(preview).toHaveTextContent("ssn-us");
  });

  it("renders 'No patterns matched' when the metadata is empty", () => {
    const requestNoMatches: EditorAssistRequest = {
      ...SAMPLE_REQUEST,
      studioRedactionMetadata: {
        studioRedactionProfileVersion: "v1.0.0",
        matchedPatternIds: [],
      },
    };
    render(
      <EditorAssistSidePanel
        open
        request={requestNoMatches}
        result={successResult()}
        onClose={() => {}}
        onRetry={() => {}}
      />,
    );
    expect(
      screen.getByTestId("editor-assist-preview-redaction"),
    ).toHaveTextContent(/No patterns matched/i);
  });

  it("exposes an accessible label on the panel and a close button", () => {
    const onClose = vi.fn();
    render(
      <EditorAssistSidePanel
        open
        request={SAMPLE_REQUEST}
        result={successResult()}
        onClose={onClose}
        onRetry={() => {}}
      />,
    );
    const panel = screen.getByRole("complementary", {
      name: /Editor-Assist explanation/i,
    });
    expect(panel).toBeInTheDocument();
    const close = screen.getByRole("button", {
      name: /Close Editor-Assist panel/i,
    });
    close.focus();
    expect(document.activeElement).toBe(close);
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("allows tabbing into the close button", () => {
    render(
      <EditorAssistSidePanel
        open
        request={SAMPLE_REQUEST}
        result={successResult()}
        onClose={() => {}}
        onRetry={() => {}}
      />,
    );
    const close = screen.getByRole("button", {
      name: /Close Editor-Assist panel/i,
    });
    // Standard HTML buttons are tabbable by default — assert the
    // tabIndex is not negative so a keyboard-only user can reach it.
    expect(close.tabIndex).toBeGreaterThanOrEqual(0);
  });

  it("Escape key calls onClose (WCAG 2.1.2 — no keyboard trap)", () => {
    const onClose = vi.fn();
    render(
      <EditorAssistSidePanel
        open
        request={SAMPLE_REQUEST}
        result={successResult()}
        onClose={onClose}
        onRetry={() => {}}
      />,
    );
    const panel = screen.getByRole("complementary", {
      name: /Editor-Assist explanation/i,
    });
    fireEvent.keyDown(panel, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("focuses the close button when the panel opens (WCAG 2.4.3)", () => {
    render(
      <EditorAssistSidePanel
        open
        request={SAMPLE_REQUEST}
        result={successResult()}
        onClose={() => {}}
        onRetry={() => {}}
      />,
    );
    const close = screen.getByRole("button", {
      name: /Close Editor-Assist panel/i,
    });
    expect(document.activeElement).toBe(close);
  });

  it("CopyChip live region announces 'Copied' after click (WCAG 4.1.3)", async () => {
    render(
      <EditorAssistSidePanel
        open
        request={SAMPLE_REQUEST}
        result={successResult()}
        onClose={() => {}}
        onRetry={() => {}}
      />,
    );
    const sourceHashBtn = screen.getByRole("button", {
      name: /Copy full source hash/i,
    });
    // The live region starts empty.
    const liveRegion = sourceHashBtn.querySelector('[role="status"]');
    expect(liveRegion).toBeTruthy();
    expect(liveRegion?.textContent).toBe("");
    fireEvent.click(sourceHashBtn);
    // After click the clipboardSpy resolves and setCopied(true) fires —
    // wait a tick for the promise microtask to flush.
    await vi.waitFor(() => {
      expect(liveRegion?.textContent).toBe("Copied");
    });
  });
});
