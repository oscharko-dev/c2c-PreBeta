import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  submitGenerateMock,
  submitTransformMock,
  startVerifyMock,
  triggerCompileCheckMock,
} = vi.hoisted(() => ({
  submitGenerateMock: vi.fn(),
  submitTransformMock: vi.fn(),
  startVerifyMock: vi.fn(),
  triggerCompileCheckMock: vi.fn(),
}));

let javaBuffersMock: Record<
  string,
  {
    content: string;
    generatorBaselineHash: string;
    bufferHash: string;
    isDirty: boolean;
    manualEditOverlay: {
      schemaVersion: "v0";
      runId: string;
      javaFile: string;
      regions: Array<{
        lineRange: { startLine: number; endLine: number };
        originClass: "manual_modified" | "manual_edit";
      }>;
    } | null;
  }
> = {};

let transformationStateMock: Record<string, unknown> = { runId: null };
let expectedOutputMock = "";
let oracleInputMock = "";

vi.mock("@/stores/sourceWorkspace", () => ({
  useSourceWorkspace: () => ({
    canSubmitTransform: true,
    submitTransform: submitTransformMock,
    submitGenerate: submitGenerateMock,
    expectedOutput: expectedOutputMock,
    oracleInput: oracleInputMock,
  }),
}));

vi.mock("@/stores/transformationRun", () => ({
  useTransformationRun: () => ({
    state: transformationStateMock,
    javaBuffers: javaBuffersMock,
    startVerify: startVerifyMock,
  }),
}));

vi.mock("@/stores/javaEditorActions", () => ({
  useJavaEditorActions: () => ({
    canCompileCheck: false,
    compileCheckPending: false,
    triggerCompileCheck: triggerCompileCheckMock,
  }),
}));

vi.mock("@/hooks/useKeyboardShortcuts", () => ({
  useKeyboardShortcuts: vi.fn(),
}));

vi.mock("@/lib/editor/editorPersistence", () => ({
  editorPersistence: {
    clearAll: vi.fn(),
    clearLocalOrigin: vi.fn(),
    countDrafts: vi.fn(async () => 0),
  },
  getCurrentDraftScope: vi.fn(async () => ({
    tenantId: "tenant-A",
    userId: "user-1",
  })),
}));

vi.mock("@/lib/editor/editorTelemetry", () => ({
  emit: vi.fn(),
}));

import { AppTopBar } from "@/components/workbench/AppTopBar";

const apiState = {
  health: { status: "ok" },
  mode: { orchestrator: "live", evidence: "live" },
  error: null,
  errorKind: null,
  loading: false,
};

function renderTopBar() {
  return render(
    <AppTopBar
      apiState={
        apiState as unknown as React.ComponentProps<
          typeof AppTopBar
        >["apiState"]
      }
    />,
  );
}

describe("AppTopBar generator actions", () => {
  beforeEach(() => {
    submitGenerateMock.mockReset();
    submitTransformMock.mockReset();
    startVerifyMock.mockReset();
    startVerifyMock.mockResolvedValue({ ok: true, data: {} });
    triggerCompileCheckMock.mockReset();
    javaBuffersMock = {};
    transformationStateMock = { runId: null };
    expectedOutputMock = "";
    oracleInputMock = "";
  });

  it("starts Generate Java immediately even when manual Java edits exist", () => {
    javaBuffersMock = {
      "src/App.java": {
        content: "class App {}",
        generatorBaselineHash: "baseline-hash",
        bufferHash: "baseline-hash",
        isDirty: true,
        manualEditOverlay: null,
      },
    };
    renderTopBar();

    fireEvent.click(screen.getByTestId("topbar-generate-button"));

    expect(submitGenerateMock).toHaveBeenCalledTimes(1);
    expect(submitGenerateMock).toHaveBeenCalledWith({
      trigger: "generate",
      hadManualEdits: true,
    });
    expect(
      screen.queryByTestId("topbar-regenerate-confirm-dialog"),
    ).not.toBeInTheDocument();
  });

  it("keeps Regenerate Java behind an explicit confirmation", () => {
    javaBuffersMock = {
      "src/App.java": {
        content: "class App {}",
        generatorBaselineHash: "baseline-hash",
        bufferHash: "baseline-hash",
        isDirty: true,
        manualEditOverlay: null,
      },
    };
    renderTopBar();

    fireEvent.click(screen.getByTestId("topbar-regenerate-button"));

    expect(submitGenerateMock).not.toHaveBeenCalled();
    expect(
      screen.getByTestId("topbar-regenerate-confirm-dialog"),
    ).toHaveTextContent("Re-run the generator with manual edits present?");

    fireEvent.click(screen.getByTestId("topbar-regenerate-confirm-proceed"));

    expect(submitGenerateMock).toHaveBeenCalledTimes(1);
    expect(submitGenerateMock).toHaveBeenCalledWith({
      trigger: "regenerate",
      hadManualEdits: true,
    });
  });

  it("passes synchronous Java dirty state into Generate & Verify telemetry", () => {
    javaBuffersMock = {
      "src/App.java": {
        content: "class App {}",
        generatorBaselineHash: "baseline-hash",
        bufferHash: "baseline-hash",
        isDirty: true,
        manualEditOverlay: null,
      },
    };
    renderTopBar();

    fireEvent.click(screen.getByTestId("topbar-generate-and-verify-button"));

    expect(submitTransformMock).toHaveBeenCalledTimes(1);
    expect(submitTransformMock).toHaveBeenCalledWith({
      trigger: "generate_and_verify",
      hadManualEdits: true,
    });
  });

  it("verifies only current-run Java buffers and forwards verification context", async () => {
    transformationStateMock = {
      runId: "run-verify",
      programId: "PROG1",
      generated: { entryClass: "com.example.Main" },
      generatedFiles: {
        entryFilePath: "src/Main.java",
        files: [{ path: "src/Main.java" }, { path: "src/Helper.java" }],
      },
    };
    expectedOutputMock = "DONE\n";
    oracleInputMock = "stdin\n";
    javaBuffersMock = {
      "src/Main.java": {
        content: "class Main {}",
        generatorBaselineHash: "main-baseline",
        bufferHash: "main-dirty",
        isDirty: true,
        manualEditOverlay: {
          schemaVersion: "v0",
          runId: "run-verify",
          javaFile: "src/Main.java",
          regions: [
            {
              lineRange: { startLine: 1, endLine: 1 },
              originClass: "manual_modified",
            },
          ],
        },
      },
      "src/Helper.java": {
        content: "class Helper {}",
        generatorBaselineHash: "helper-baseline",
        bufferHash: "helper-dirty",
        isDirty: true,
        manualEditOverlay: {
          schemaVersion: "v0",
          runId: "run-verify",
          javaFile: "src/Helper.java",
          regions: [
            {
              lineRange: { startLine: 2, endLine: 2 },
              originClass: "manual_edit",
            },
          ],
        },
      },
      "src/Stale.java": {
        content: "class Stale {}",
        generatorBaselineHash: "stale-baseline",
        bufferHash: "stale-dirty",
        isDirty: true,
        manualEditOverlay: null,
      },
    };
    renderTopBar();

    fireEvent.click(screen.getByTestId("topbar-verify-button"));

    await waitFor(() => {
      expect(startVerifyMock).toHaveBeenCalledTimes(1);
    });
    expect(startVerifyMock).toHaveBeenCalledWith({
      runId: "run-verify",
      programId: "PROG1",
      entryClass: "com.example.Main",
      entryFilePath: "src/Main.java",
      expectedOutput: "DONE\n",
      oracleInput: "stdin\n",
      javaFiles: [
        { path: "src/Main.java", content: "class Main {}" },
        { path: "src/Helper.java", content: "class Helper {}" },
      ],
      manualEditOverlays: [
        javaBuffersMock["src/Main.java"].manualEditOverlay,
        javaBuffersMock["src/Helper.java"].manualEditOverlay,
      ],
    });
  });

  it("omits entry metadata when the entry file is not in the verified buffers", async () => {
    transformationStateMock = {
      runId: "run-verify",
      programId: "PROG1",
      generated: { entryClass: "com.example.Main" },
      generatedFiles: {
        entryFilePath: "src/Main.java",
        files: [{ path: "src/Main.java" }, { path: "src/Helper.java" }],
      },
    };
    javaBuffersMock = {
      "src/Helper.java": {
        content: "class Helper {}",
        generatorBaselineHash: "helper-baseline",
        bufferHash: "helper-baseline",
        isDirty: false,
        manualEditOverlay: null,
      },
    };
    renderTopBar();

    fireEvent.click(screen.getByTestId("topbar-verify-button"));

    await waitFor(() => {
      expect(startVerifyMock).toHaveBeenCalledTimes(1);
    });
    expect(startVerifyMock).toHaveBeenCalledWith({
      runId: "run-verify",
      programId: "PROG1",
      javaFiles: [{ path: "src/Helper.java", content: "class Helper {}" }],
    });
  });
});
