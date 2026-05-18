/**
 * Studio-IDE-3 (#247): unit tests for the three-way conflict resolver
 * dialog. Used for both COBOL and Java drafts; the test matrix covers
 * both kinds, all three choices, the dismiss path, and the Escape
 * keyboard shortcut.
 */

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import {
  ConflictResolverDialog,
  type ConflictPanel,
} from "@/components/source/ConflictResolverDialog";

const cobolPanels: ConflictPanel[] = [
  {
    id: "backendSample",
    title: "Backend sample",
    description: "BFF-supplied content.",
    content: "PROGRAM A\n",
  },
  {
    id: "localDraft",
    title: "Local draft",
    description: "Saved on this device.",
    content: "PROGRAM B\n",
  },
  {
    id: "lastRunInput",
    title: "Last run input",
    description: "Content sent to the last run.",
    content: "PROGRAM C\n",
  },
];

const javaPanels: ConflictPanel[] = [
  {
    id: "backendSample",
    title: "Backend Java",
    description: "Generated Java from the BFF.",
    content: "class Foo {}",
  },
  {
    id: "localDraft",
    title: "Local Java draft",
    description: "Java edits saved locally.",
    content: "class Foo { int x; }",
  },
  {
    id: "lastRunInput",
    title: "Last Java run input",
    description: "Java content from the last completed run.",
    content: "class Foo { String s; }",
  },
];

describe("ConflictResolverDialog", () => {
  it("renders the three labelled panels for COBOL", () => {
    const onChoose = vi.fn();
    const onDismiss = vi.fn();
    render(
      <ConflictResolverDialog
        kind="cobol"
        panels={cobolPanels}
        onChoose={onChoose}
        onDismiss={onDismiss}
      />,
    );

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "COBOL draft conflict" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Backend sample")).toBeInTheDocument();
    expect(screen.getByText("Local draft")).toBeInTheDocument();
    expect(screen.getByText("Last run input")).toBeInTheDocument();
    // Each panel surfaces its content for review.
    expect(screen.getByText("PROGRAM A")).toBeInTheDocument();
    expect(screen.getByText("PROGRAM B")).toBeInTheDocument();
    expect(screen.getByText("PROGRAM C")).toBeInTheDocument();
  });

  it("shows the Java file path in the title for Java conflicts", () => {
    render(
      <ConflictResolverDialog
        kind="java"
        filePath="src/main/java/com/example/Foo.java"
        panels={javaPanels}
        onChoose={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("heading", {
        name: /Java draft conflict — src\/main\/java\/com\/example\/Foo\.java/,
      }),
    ).toBeInTheDocument();
  });

  it.each([
    ["backendSample" as const, "Keep Backend sample"],
    ["localDraft" as const, "Keep Local draft"],
    ["lastRunInput" as const, "Keep Last run input"],
  ])(
    "invokes onChoose(%s) when the corresponding Keep button is clicked",
    (choice, label) => {
      const onChoose = vi.fn();
      render(
        <ConflictResolverDialog
          kind="cobol"
          panels={cobolPanels}
          onChoose={onChoose}
          onDismiss={vi.fn()}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: label }));
      expect(onChoose).toHaveBeenCalledTimes(1);
      expect(onChoose).toHaveBeenCalledWith(choice);
    },
  );

  it("invokes onDismiss when the Cancel button is clicked", () => {
    const onDismiss = vi.fn();
    render(
      <ConflictResolverDialog
        kind="cobol"
        panels={cobolPanels}
        onChoose={vi.fn()}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("invokes onDismiss when Escape is pressed", () => {
    const onDismiss = vi.fn();
    render(
      <ConflictResolverDialog
        kind="java"
        filePath="src/Foo.java"
        panels={javaPanels}
        onChoose={vi.fn()}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("renders an empty-content placeholder when a panel has no content", () => {
    const panels: ConflictPanel[] = [
      cobolPanels[0],
      { ...cobolPanels[1], content: "" },
      cobolPanels[2],
    ];
    render(
      <ConflictResolverDialog
        kind="cobol"
        panels={panels}
        onChoose={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByText("(empty)")).toBeInTheDocument();
  });
});
