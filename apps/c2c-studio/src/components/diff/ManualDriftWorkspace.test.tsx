import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { ManualDriftWorkspace } from "@/components/diff/ManualDriftWorkspace";
import type { JavaOriginOverlay } from "@/types/api";

type DiffEditorMockProps = {
  language: string;
  original: string;
  value: string;
  modelUri?: string;
  originalModelUri?: string;
  ariaLabel?: string;
  className?: string;
  onMount?: (args: { editor: typeof fakeDiffEditor; monaco: typeof fakeMonaco }) => void;
};

interface CapturedDiffMount {
  language: string;
  original: string;
  value: string;
  modelUri: string | undefined;
  originalModelUri: string | undefined;
  ariaLabel: string | undefined;
}

const diffMounts: CapturedDiffMount[] = [];
const originalDecorationSets: unknown[][] = [];
const modifiedDecorationSets: unknown[][] = [];
const originalCommands: number[] = [];
const modifiedCommands: number[] = [];
let originalContent = "";
let modifiedContent = "";

const fakeMonaco = {
  KeyMod: { Shift: 1 << 10 },
  KeyCode: { F7: 67 },
};

function lineCount(content: string): number {
  if (content.length === 0) return 1;
  const lines = content.split("\n");
  if (content.endsWith("\n") && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return Math.max(1, lines.length);
}

const originalEditor = {
  addCommand: (keybinding: number) => {
    originalCommands.push(keybinding);
    return `original-command-${originalCommands.length}`;
  },
  getPosition: () => ({ lineNumber: 1, column: 1 }),
  revealLineInCenter: vi.fn(),
  setPosition: vi.fn(),
  focus: vi.fn(),
  getModel: () => ({ getLineCount: () => lineCount(originalContent) }),
  createDecorationsCollection: (decorations: unknown[]) => {
    originalDecorationSets.push(decorations);
    return {
      set: (nextDecorations: unknown[]) => {
        originalDecorationSets.push(nextDecorations);
      },
      clear: vi.fn(),
    };
  },
};

const modifiedEditor = {
  addCommand: (keybinding: number) => {
    modifiedCommands.push(keybinding);
    return `modified-command-${modifiedCommands.length}`;
  },
  getPosition: () => ({ lineNumber: 1, column: 1 }),
  revealLineInCenter: vi.fn(),
  setPosition: vi.fn(),
  focus: vi.fn(),
  getModel: () => ({ getLineCount: () => lineCount(modifiedContent) }),
  createDecorationsCollection: (decorations: unknown[]) => {
    modifiedDecorationSets.push(decorations);
    return {
      set: (nextDecorations: unknown[]) => {
        modifiedDecorationSets.push(nextDecorations);
      },
      clear: vi.fn(),
    };
  },
};

const fakeDiffEditor = {
  getOriginalEditor: () => originalEditor,
  getModifiedEditor: () => modifiedEditor,
  getLineChanges: () => [
    {
      modifiedStartLineNumber: 2,
      modifiedEndLineNumber: 2,
    },
  ],
};

vi.mock("@/components/editor/CodeEditor", async () => {
  const reactNs = await import("react");
  const CodeEditor = (props: DiffEditorMockProps) => {
    reactNs.useEffect(() => {
      originalContent = props.original;
      modifiedContent = props.value;
      diffMounts.push({
        language: props.language,
        original: props.original,
        value: props.value,
        modelUri: props.modelUri,
        originalModelUri: props.originalModelUri,
        ariaLabel: props.ariaLabel,
      });
      props.onMount?.({ editor: fakeDiffEditor, monaco: fakeMonaco });
    }, []);
    return reactNs.createElement(
      "div",
      {
        "data-testid": "manual-drift-code-editor",
        "data-language": props.language,
        "data-model-uri": props.modelUri,
        "data-original-uri": props.originalModelUri,
        "aria-label": props.ariaLabel,
        className: props.className,
      },
      reactNs.createElement("pre", { "data-side": "original" }, props.original),
      reactNs.createElement("pre", { "data-side": "modified" }, props.value),
    );
  };
  return { CodeEditor };
});

const manualOverlay: JavaOriginOverlay = {
  schemaVersion: "v0",
  runId: "run-current-9999",
  javaFile: "src/App.java",
  regions: [
    {
      lineRange: { startLine: 2, endLine: 2 },
      originClass: "manual_modified",
    },
    {
      lineRange: { startLine: 4, endLine: 5 },
      originClass: "manual_edit",
    },
  ],
};

describe("ManualDriftWorkspace", () => {
  beforeEach(() => {
    diffMounts.length = 0;
    originalDecorationSets.length = 0;
    modifiedDecorationSets.length = 0;
    originalCommands.length = 0;
    modifiedCommands.length = 0;
    originalContent = "";
    modifiedContent = "";
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders an explicit empty state when no Generator Baseline exists", () => {
    const onClose = vi.fn();
    render(
      <ManualDriftWorkspace
        filePath="src/App.java"
        runId="run-current-9999"
        baselineRunId={null}
        baselineContent={null}
        currentContent="public class App {}"
        manualOverlay={null}
        onClose={onClose}
      />,
    );

    expect(
      screen.getByTestId("manual-drift-workspace-empty"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("No Generator Baseline exists for this file yet."),
    ).toBeInTheDocument();
    expect(diffMounts).toHaveLength(0);

    fireEvent.click(screen.getByLabelText("Close manual drift"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders Generator Baseline versus current buffer with stable diff URIs", () => {
    render(
      <ManualDriftWorkspace
        filePath="src/App.java"
        runId="run-current-9999"
        baselineRunId="run-base-1111"
        baselineContent={"class App {\n  int a;\n}\n"}
        currentContent={"class App {\n  int b;\n  int c;\n}\n"}
        manualOverlay={manualOverlay}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByTestId("manual-drift-workspace")).toBeInTheDocument();
    expect(screen.getByText("Manual Drift - App.java")).toBeInTheDocument();
    expect(diffMounts).toHaveLength(1);
    expect(diffMounts[0]).toMatchObject({
      language: "java",
      original: "class App {\n  int a;\n}\n",
      value: "class App {\n  int b;\n  int c;\n}\n",
      originalModelUri:
        "inmemory://c2c-studio/diff/manual-drift/run-base-1111/src/App.java~original",
      modelUri:
        "inmemory://c2c-studio/diff/manual-drift/run-current-9999/src/App.java~modified",
      ariaLabel: "Manual drift diff for src/App.java",
    });
  });

  it("paints manual provenance on the modified side and clamped modified regions on the baseline side", () => {
    render(
      <ManualDriftWorkspace
        filePath="src/App.java"
        runId="run-current-9999"
        baselineRunId="run-base-1111"
        baselineContent={"class App {\n  int a;\n}\n"}
        currentContent={"class App {\n  int b;\n  int c;\n  int d;\n}\n"}
        manualOverlay={manualOverlay}
        initialFocusLine={4}
        onClose={vi.fn()}
      />,
    );

    const modifiedDecorations = modifiedDecorationSets.at(-1) as Array<{
      options: { linesDecorationsClassName: string };
    }>;
    const originalDecorations = originalDecorationSets.at(-1) as Array<{
      options: { linesDecorationsClassName: string };
    }>;

    expect(modifiedDecorations).toHaveLength(2);
    expect(
      modifiedDecorations[0]?.options.linesDecorationsClassName,
    ).toContain("manual-modified");
    expect(
      modifiedDecorations[1]?.options.linesDecorationsClassName,
    ).toContain("manual-edit");
    expect(originalDecorations).toHaveLength(1);
    expect(
      originalDecorations[0]?.options.linesDecorationsClassName,
    ).toContain("manual-modified");
    expect(modifiedEditor.revealLineInCenter).toHaveBeenCalledWith(4);
    expect(modifiedEditor.setPosition).toHaveBeenCalledWith({
      lineNumber: 4,
      column: 1,
    });
    expect(modifiedEditor.focus).toHaveBeenCalled();
    expect(modifiedCommands).toHaveLength(2);
    expect(originalCommands).toHaveLength(2);
  });
});
