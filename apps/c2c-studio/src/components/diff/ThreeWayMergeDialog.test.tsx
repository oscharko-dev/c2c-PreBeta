/**
 * Studio-IDE-13 (#255): unit tests for ThreeWayMergeDialog.
 * Covers rendering, radio selection, apply/cancel, Esc, Show Diff Detail
 * toggle, and the summary row counts.
 */

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import {
  ThreeWayMergeDialog,
  type MergeConflictRegion,
  type ThreeWayMergeDialogProps,
} from "@/components/diff/ThreeWayMergeDialog";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const conflictRegion: MergeConflictRegion = {
  id: "r1",
  lineRange: { startLine: 10, endLine: 20 },
  conflictKind: "conflict",
  baselineContent: "baseline code",
  manualContent: "manual code",
  newGeneratorContent: "new gen code",
  suggestedResolution: null,
  needsUserPick: true,
};

const manualOnlyRegion: MergeConflictRegion = {
  id: "r2",
  lineRange: { startLine: 25, endLine: 30 },
  conflictKind: "manual_only",
  baselineContent: "",
  manualContent: "manual only code",
  newGeneratorContent: "",
  suggestedResolution: "manual",
  needsUserPick: false,
};

const newGeneratorOnlyRegion: MergeConflictRegion = {
  id: "r3",
  lineRange: { startLine: 35, endLine: 40 },
  conflictKind: "new_generator_only",
  baselineContent: "",
  manualContent: "",
  newGeneratorContent: "new gen only code",
  suggestedResolution: "newGenerator",
  needsUserPick: false,
};

const agreedRegion: MergeConflictRegion = {
  id: "r4",
  lineRange: { startLine: 45, endLine: 50 },
  conflictKind: "agreed",
  baselineContent: "agreed code",
  manualContent: "agreed code",
  newGeneratorContent: "agreed code",
  suggestedResolution: "manual",
  needsUserPick: false,
};

const defaultProps: ThreeWayMergeDialogProps = {
  filePath: "src/main/java/com/example/Foo.java",
  baselineContent: "baseline file content",
  manualContent: "manual file content",
  newGeneratorContent: "new generator file content",
  regions: [conflictRegion],
  onApply: vi.fn(),
  onCancel: vi.fn(),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ThreeWayMergeDialog", () => {
  it("renders three column panels with the correct labels", () => {
    render(<ThreeWayMergeDialog {...defaultProps} />);

    expect(screen.getByText("Generator Baseline")).toBeInTheDocument();
    expect(screen.getByText("Current Manual State")).toBeInTheDocument();
    expect(screen.getByText("New Generator Output")).toBeInTheDocument();
  });

  it("renders the file path in the dialog title", () => {
    render(<ThreeWayMergeDialog {...defaultProps} />);

    expect(
      screen.getByRole("heading", {
        name: /3-Way Merge — src\/main\/java\/com\/example\/Foo\.java/,
      }),
    ).toBeInTheDocument();
  });

  it("has correct ARIA attributes", () => {
    render(<ThreeWayMergeDialog {...defaultProps} />);

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAttribute("aria-labelledby", "threewaymerge-title");
  });

  it("renders a row per region showing the line range", () => {
    render(
      <ThreeWayMergeDialog
        {...defaultProps}
        regions={[conflictRegion, manualOnlyRegion]}
      />,
    );

    expect(screen.getByText("Lines 10–20")).toBeInTheDocument();
    expect(screen.getByText("Lines 25–30")).toBeInTheDocument();
  });

  it("conflict region: renders three radio options including Baseline", () => {
    render(
      <ThreeWayMergeDialog {...defaultProps} regions={[conflictRegion]} />,
    );

    const group = screen.getByRole("radiogroup", {
      name: "Region 10-20",
    });
    expect(group).toBeInTheDocument();

    const radios = screen.getAllByRole("radio");
    // Keep Manual, Take New Generator, Keep Baseline
    expect(radios).toHaveLength(3);
  });

  it("conflict region: Apply is disabled when needsUserPick region has no selection", () => {
    render(
      <ThreeWayMergeDialog {...defaultProps} regions={[conflictRegion]} />,
    );

    const applyBtn = screen.getByRole("button", { name: "Apply Selection" });
    expect(applyBtn).toBeDisabled();
  });

  it("conflict region: Apply is enabled after user picks a choice", () => {
    render(
      <ThreeWayMergeDialog {...defaultProps} regions={[conflictRegion]} />,
    );

    const newGenRadio = screen.getByRole("radio", {
      name: "Take New Generator",
    });
    fireEvent.click(newGenRadio);

    const applyBtn = screen.getByRole("button", { name: "Apply Selection" });
    expect(applyBtn).not.toBeDisabled();
  });

  it("manual_only region: pre-selected manual; radio group is disabled; does not block Apply", () => {
    render(
      <ThreeWayMergeDialog {...defaultProps} regions={[manualOnlyRegion]} />,
    );

    const manualRadio = screen.getByRole("radio", { name: "Keep Manual" });
    expect(manualRadio).toBeChecked();
    expect(manualRadio).toBeDisabled();

    // Apply should be enabled because no needsUserPick regions are unresolved.
    const applyBtn = screen.getByRole("button", { name: "Apply Selection" });
    expect(applyBtn).not.toBeDisabled();
  });

  it("new_generator_only region: pre-selected newGenerator; radio disabled; does not block Apply", () => {
    render(
      <ThreeWayMergeDialog
        {...defaultProps}
        regions={[newGeneratorOnlyRegion]}
      />,
    );

    const ngRadio = screen.getByRole("radio", { name: "Take New Generator" });
    expect(ngRadio).toBeChecked();
    expect(ngRadio).toBeDisabled();

    const applyBtn = screen.getByRole("button", { name: "Apply Selection" });
    expect(applyBtn).not.toBeDisabled();
  });

  it("agreed region: pre-selected manual; radio disabled", () => {
    render(<ThreeWayMergeDialog {...defaultProps} regions={[agreedRegion]} />);

    const manualRadio = screen.getByRole("radio", { name: "Keep Manual" });
    expect(manualRadio).toBeChecked();
    expect(manualRadio).toBeDisabled();
  });

  it("clicking Take New Generator on a conflict region updates selection and Apply fires onApply", () => {
    const onApply = vi.fn();
    render(
      <ThreeWayMergeDialog
        {...defaultProps}
        regions={[conflictRegion]}
        onApply={onApply}
      />,
    );

    fireEvent.click(screen.getByRole("radio", { name: "Take New Generator" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply Selection" }));

    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply).toHaveBeenCalledWith({ r1: "newGenerator" });
  });

  it("Apply fires onApply with all selections including auto-resolved regions", () => {
    const onApply = vi.fn();
    render(
      <ThreeWayMergeDialog
        {...defaultProps}
        regions={[conflictRegion, manualOnlyRegion, newGeneratorOnlyRegion]}
        onApply={onApply}
      />,
    );

    // Resolve the conflict region.
    fireEvent.click(screen.getByRole("radio", { name: "Keep Baseline" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply Selection" }));

    expect(onApply).toHaveBeenCalledWith({
      r1: "baseline",
      r2: "manual",
      r3: "newGenerator",
    });
  });

  it("Cancel button fires onCancel", () => {
    const onCancel = vi.fn();
    render(<ThreeWayMergeDialog {...defaultProps} onCancel={onCancel} />);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("Esc key fires onCancel", () => {
    const onCancel = vi.fn();
    render(<ThreeWayMergeDialog {...defaultProps} onCancel={onCancel} />);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("Show Diff Detail toggles the expanded per-region view", () => {
    render(
      <ThreeWayMergeDialog {...defaultProps} regions={[conflictRegion]} />,
    );

    const toggleBtn = screen.getByRole("button", { name: "Show Diff Detail" });

    // Expanded view not visible yet.
    expect(screen.queryByText("Hide Diff Detail")).not.toBeInTheDocument();

    fireEvent.click(toggleBtn);

    // Button text changes.
    expect(
      screen.getByRole("button", { name: "Hide Diff Detail" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Show Diff Detail" }),
    ).not.toBeInTheDocument();

    // Toggle back.
    fireEvent.click(screen.getByRole("button", { name: "Hide Diff Detail" }));
    expect(
      screen.getByRole("button", { name: "Show Diff Detail" }),
    ).toBeInTheDocument();
  });

  it("Show Diff Detail reveals per-region three-content blocks with region content", () => {
    render(
      <ThreeWayMergeDialog {...defaultProps} regions={[conflictRegion]} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Show Diff Detail" }));

    // Three labelled blocks inside the expanded region.
    expect(screen.getAllByText("Generator Baseline")).toHaveLength(2); // column header + detail header
    expect(screen.getAllByText("Current Manual State")).toHaveLength(2);
    expect(screen.getAllByText("New Generator Output")).toHaveLength(2);

    expect(screen.getByText("baseline code")).toBeInTheDocument();
    expect(screen.getByText("manual code")).toBeInTheDocument();
    expect(screen.getByText("new gen code")).toBeInTheDocument();
  });

  describe("summary row", () => {
    it("reports conflict count correctly", () => {
      render(
        <ThreeWayMergeDialog {...defaultProps} regions={[conflictRegion]} />,
      );

      expect(
        screen.getByText(/1 conflict requiring choice/),
      ).toBeInTheDocument();
    });

    it("uses plural 'conflicts' for more than one conflict region", () => {
      const second: MergeConflictRegion = {
        ...conflictRegion,
        id: "r1b",
        lineRange: { startLine: 60, endLine: 70 },
      };
      render(
        <ThreeWayMergeDialog
          {...defaultProps}
          regions={[conflictRegion, second]}
        />,
      );

      expect(
        screen.getByText(/2 conflicts requiring choice/),
      ).toBeInTheDocument();
    });

    it("reports auto-resolved manual, new generator and agreed counts", () => {
      render(
        <ThreeWayMergeDialog
          {...defaultProps}
          regions={[
            conflictRegion,
            manualOnlyRegion,
            newGeneratorOnlyRegion,
            agreedRegion,
          ]}
        />,
      );

      expect(
        screen.getByText(/1 conflict requiring choice/),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/1 auto-resolved \(manual\)/),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/1 auto-resolved \(new generator\)/),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/1 auto-resolved \(agreed\)/),
      ).toBeInTheDocument();
    });

    it("shows 'No regions' when the regions array is empty", () => {
      render(<ThreeWayMergeDialog {...defaultProps} regions={[]} />);

      expect(screen.getByText("No regions")).toBeInTheDocument();
    });
  });

  it("initialSelections pre-populates conflict region selection so Apply is immediately enabled", () => {
    const onApply = vi.fn();
    render(
      <ThreeWayMergeDialog
        {...defaultProps}
        regions={[conflictRegion]}
        initialSelections={{ r1: "manual" }}
        onApply={onApply}
      />,
    );

    const applyBtn = screen.getByRole("button", { name: "Apply Selection" });
    expect(applyBtn).not.toBeDisabled();

    fireEvent.click(applyBtn);
    expect(onApply).toHaveBeenCalledWith({ r1: "manual" });
  });

  it("radiogroup has correct aria-label per region", () => {
    render(
      <ThreeWayMergeDialog
        {...defaultProps}
        regions={[conflictRegion, manualOnlyRegion]}
      />,
    );

    expect(
      screen.getByRole("radiogroup", { name: "Region 10-20" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("radiogroup", { name: "Region 25-30" }),
    ).toBeInTheDocument();
  });

  it("baseline_only region: renders Keep Baseline option and disables radios", () => {
    const baselineOnly: MergeConflictRegion = {
      id: "r5",
      lineRange: { startLine: 55, endLine: 60 },
      conflictKind: "baseline_only",
      baselineContent: "baseline only",
      manualContent: "",
      newGeneratorContent: "",
      suggestedResolution: "manual",
      needsUserPick: false,
    };
    render(<ThreeWayMergeDialog {...defaultProps} regions={[baselineOnly]} />);

    // Baseline is available for baseline_only.
    expect(
      screen.getByRole("radio", { name: "Keep Baseline" }),
    ).toBeInTheDocument();
    // Auto-resolved → disabled.
    expect(screen.getByRole("radio", { name: "Keep Manual" })).toBeDisabled();
  });
});
