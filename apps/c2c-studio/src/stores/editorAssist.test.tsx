import { render, screen, fireEvent, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

import { requestExplanation } from "@/lib/editor/editorAssistClient";
import type {
  EditorAssistRequest,
  EditorAssistResult,
} from "@/types/editor-assist";
import { EDITOR_ASSIST_SCHEMA_VERSION } from "@/types/editor-assist";
import { EditorAssistProvider, useEditorAssist } from "./editorAssist";

vi.mock("@/lib/editor/editorAssistClient", () => ({
  requestExplanation: vi.fn(),
}));

const requestExplanationMock = vi.mocked(requestExplanation);

function makeRequest(filePath: string): EditorAssistRequest {
  return {
    schemaVersion: EDITOR_ASSIST_SCHEMA_VERSION,
    sessionId: "session-1",
    runId: null,
    sourceHash: "a".repeat(64),
    region: {
      filePath,
      sourceKind: "cobol",
      startLine: 1,
      endLine: 1,
    },
    redactedBytes: "MOVE A TO B.",
    byteHash: "b".repeat(64),
    studioRedactionMetadata: {
      studioRedactionProfileVersion: "v1.1.0",
      matchedPatternIds: [],
    },
  };
}

function successResult(filePath: string, remaining: number): EditorAssistResult {
  return {
    ok: true,
    data: {
      schemaVersion: EDITOR_ASSIST_SCHEMA_VERSION,
      explanation: `Explanation for ${filePath}`,
      modelInvocationRef: `mi-${filePath}`,
      editorAssistRef: `eai-${filePath}`,
      ledgerRef: `ledger-${filePath}`,
      budgetSnapshot: { limit: 3, used: 3 - remaining, remaining },
      redactionApplied: [],
    },
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function Probe() {
  const assist = useEditorAssist();
  return (
    <div>
      <div data-testid="open">{String(assist.panelOpen)}</div>
      <div data-testid="request">{assist.request?.region.filePath ?? "none"}</div>
      <div data-testid="result">
        {assist.result?.ok ? assist.result.data.explanation : "none"}
      </div>
      <div data-testid="remaining">
        {assist.budgetSnapshot?.remaining ?? "unknown"}
      </div>
      <button
        type="button"
        onClick={() => void assist.runExplain(makeRequest("A.cbl"))}
      >
        run-a
      </button>
      <button
        type="button"
        onClick={() => void assist.runExplain(makeRequest("B.cbl"))}
      >
        run-b
      </button>
      <button type="button" onClick={() => void assist.retry()}>
        retry
      </button>
      <button type="button" onClick={assist.closePanel}>
        close
      </button>
    </div>
  );
}

function renderProvider() {
  return render(
    <EditorAssistProvider>
      <Probe />
    </EditorAssistProvider>,
  );
}

describe("EditorAssistProvider", () => {
  beforeEach(() => {
    requestExplanationMock.mockReset();
  });

  it("opens the panel, stores the latest result, caches budget, and closes", async () => {
    requestExplanationMock.mockResolvedValueOnce(successResult("A.cbl", 2));
    renderProvider();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "run-a" }));
    });

    expect(screen.getByTestId("open")).toHaveTextContent("true");
    expect(screen.getByTestId("request")).toHaveTextContent("A.cbl");
    expect(screen.getByTestId("result")).toHaveTextContent(
      "Explanation for A.cbl",
    );
    expect(screen.getByTestId("remaining")).toHaveTextContent("2");

    fireEvent.click(screen.getByRole("button", { name: "close" }));
    expect(screen.getByTestId("open")).toHaveTextContent("false");
  });

  it("does not let stale responses overwrite a newer explain request", async () => {
    const first = deferred<EditorAssistResult>();
    const second = deferred<EditorAssistResult>();
    requestExplanationMock
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    renderProvider();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "run-a" }));
      fireEvent.click(screen.getByRole("button", { name: "run-b" }));
    });
    await act(async () => {
      second.resolve(successResult("B.cbl", 1));
    });
    expect(screen.getByTestId("result")).toHaveTextContent(
      "Explanation for B.cbl",
    );
    expect(screen.getByTestId("remaining")).toHaveTextContent("1");

    await act(async () => {
      first.resolve(successResult("A.cbl", 2));
    });
    expect(screen.getByTestId("result")).toHaveTextContent(
      "Explanation for B.cbl",
    );
    expect(screen.getByTestId("remaining")).toHaveTextContent("1");
  });

  it("retries the current request", async () => {
    requestExplanationMock
      .mockResolvedValueOnce(successResult("A.cbl", 2))
      .mockResolvedValueOnce(successResult("A.cbl", 1));
    renderProvider();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "run-a" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "retry" }));
    });

    expect(requestExplanationMock).toHaveBeenCalledTimes(2);
    expect(requestExplanationMock.mock.calls[1]?.[0].region.filePath).toBe(
      "A.cbl",
    );
    expect(screen.getByTestId("remaining")).toHaveTextContent("1");
  });
});
