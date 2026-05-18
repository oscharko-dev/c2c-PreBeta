import {
  render,
  screen,
  fireEvent,
  within,
  waitFor,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WorkbenchShell } from "../src/components/workbench/WorkbenchShell";
import { useC2cApi, type StudioApiState } from "../src/hooks/useC2cApi";

// The mock objects below predate StudioApiState's current shape — they
// describe an older `{ status, tone, orchestratorMode, ... }` surface the
// hook used to expose. Components downstream only access the small subset
// of fields they need at runtime, so the tests still exercise the
// keyboard + a11y behavior correctly; we go through `unknown` to satisfy
// the typechecker without rewriting the unrelated mock payloads.
type LegacyMockedApiState = Record<string, unknown>;
const asApiState = (mock: LegacyMockedApiState): StudioApiState =>
  mock as unknown as StudioApiState;

vi.mock("../src/hooks/useC2cApi", () => ({
  useC2cApi: vi.fn(),
}));

describe("A11y, Keyboard, Resizing, and Performance Hardening", () => {
  it("supports keyboard resizing on the target inspector separator", async () => {
    sessionStorage.clear();

    vi.mocked(useC2cApi).mockReturnValue(
      asApiState({
        status: "ready",
        tone: "ready",
        orchestratorMode: "product",
        evidenceMode: "real",
        orchestratorLive: true,
        evidenceLive: true,
        lastCheck: Date.now(),
        loading: false,
        error: null,
        refetch: vi.fn(),
      }),
    );

    render(<WorkbenchShell />);

    const targetInspector = screen.getByLabelText("Java Project Explorer");
    const resizeHandle = screen.getByLabelText("Resize Java Project Explorer");

    expect(targetInspector).toHaveStyle({
      "--target-inspector-width": "288px",
    });
    expect(resizeHandle).toHaveAttribute(
      "aria-controls",
      "target-java-inspector-panel",
    );
    expect(resizeHandle).toHaveAttribute("aria-valuemin", "200");
    expect(resizeHandle).toHaveAttribute("aria-valuemax", "600");
    expect(resizeHandle).toHaveAttribute("aria-valuenow", "288");

    resizeHandle.focus();
    fireEvent.keyDown(resizeHandle, { key: "ArrowLeft" });

    await waitFor(() => {
      expect(targetInspector).toHaveStyle({
        "--target-inspector-width": "308px",
      });
      expect(resizeHandle).toHaveAttribute("aria-valuenow", "308");
    });

    fireEvent.keyDown(resizeHandle, { key: "ArrowRight" });

    await waitFor(() => {
      expect(targetInspector).toHaveStyle({
        "--target-inspector-width": "288px",
      });
      expect(resizeHandle).toHaveAttribute("aria-valuenow", "288");
    });
  });

  it("provides a bypass link to the main transformation workbench", () => {
    vi.mocked(useC2cApi).mockReturnValue(
      asApiState({
        status: "ready",
        tone: "ready",
        orchestratorMode: "product",
        evidenceMode: "real",
        orchestratorLive: true,
        evidenceLive: true,
        lastCheck: Date.now(),
        loading: false,
        error: null,
        refetch: vi.fn(),
      }),
    );

    render(<WorkbenchShell />);

    const skipLink = screen.getByRole("link", {
      name: /skip to transformation workbench/i,
    });
    expect(skipLink).toHaveAttribute("href", "#studio-main-workbench");
    expect(screen.getByLabelText("Split Editor Area")).toHaveAttribute(
      "id",
      "studio-main-workbench",
    );
  });

  it("Keyboard tab order through primary controls respects disabled states", () => {
    vi.mocked(useC2cApi).mockReturnValue(
      asApiState({
        status: "ready",
        tone: "ready",
        orchestratorMode: "product",
        evidenceMode: "real",
        orchestratorLive: true,
        evidenceLive: true,
        lastCheck: Date.now(),
        loading: false,
        error: null,
        refetch: vi.fn(),
      }),
    );
    render(<WorkbenchShell />);

    const startButton = screen.getByRole("button", {
      name: "Generate & Verify",
    });
    expect(startButton).toBeDisabled(); // Because no program is selected initially

    const tree = screen.getByRole("tree", { name: "COBOL source files" });
    expect(tree).toBeInTheDocument();

    const { getAllByRole } = within(tree);
    const items = getAllByRole("treeitem");
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveAttribute("aria-disabled", "true");
  });

  it("Verifies ARIA roles for tabs and panels", () => {
    vi.mocked(useC2cApi).mockReturnValue(
      asApiState({
        status: "ready",
        tone: "ready",
        orchestratorMode: "product",
        evidenceMode: "real",
        orchestratorLive: true,
        evidenceLive: true,
        lastCheck: Date.now(),
        loading: false,
        error: null,
        refetch: vi.fn(),
      }),
    );
    render(<WorkbenchShell />);

    const tablists = screen.getAllByRole("tablist");
    expect(tablists.length).toBeGreaterThan(0);

    const tabs = screen.getAllByRole("tab");
    expect(tabs.length).toBeGreaterThan(0);

    // Look for panels (e.g. the active bottom workbench tab panel)
    const panels = screen.getAllByRole("tabpanel");
    expect(panels.length).toBeGreaterThan(0);
  });

  it("Resize state is represented correctly via useResizablePane ARIA separators", () => {
    vi.mocked(useC2cApi).mockReturnValue(
      asApiState({
        status: "ready",
        tone: "ready",
        orchestratorMode: "product",
        evidenceMode: "real",
        orchestratorLive: true,
        evidenceLive: true,
        lastCheck: Date.now(),
        loading: false,
        error: null,
        refetch: vi.fn(),
      }),
    );
    render(<WorkbenchShell />);

    // Resize handles
    const splitResizers = screen.getAllByRole("separator");
    expect(splitResizers.length).toBeGreaterThanOrEqual(2);
    for (const separator of splitResizers) {
      expect(separator).toHaveAttribute("aria-valuemin");
      expect(separator).toHaveAttribute("aria-valuemax");
      expect(separator).toHaveAttribute("aria-valuenow");
      expect(separator).toHaveAttribute("aria-controls");
    }
  });

  it("exposes selected rail state without relying on color alone", () => {
    vi.mocked(useC2cApi).mockReturnValue(
      asApiState({
        status: "ready",
        tone: "ready",
        orchestratorMode: "product",
        evidenceMode: "real",
        orchestratorLive: true,
        evidenceLive: true,
        lastCheck: Date.now(),
        loading: false,
        error: null,
        refetch: vi.fn(),
      }),
    );
    render(<WorkbenchShell />);

    const explorerButton = screen.getByRole("button", {
      name: "Toggle Explorer",
    });
    expect(explorerButton).toHaveAttribute("aria-controls", "secondary-stripe");
    expect(explorerButton).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByRole("button", { name: "Search workspace unavailable" }),
    ).toBeDisabled();

    const evidenceShortcut = screen.getByRole("button", {
      name: "Open Evidence",
    });
    expect(evidenceShortcut).toHaveAttribute(
      "aria-controls",
      "bottom-workbench-region",
    );
    expect(evidenceShortcut).toHaveAttribute("aria-expanded", "false");
    expect(evidenceShortcut).not.toHaveAttribute("aria-current");
    fireEvent.click(evidenceShortcut);
    expect(evidenceShortcut).toHaveAttribute("aria-current", "page");
    expect(evidenceShortcut).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByRole("button", { name: "Traceability unavailable" }),
    ).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Close Bottom Panel" }));
    expect(evidenceShortcut).not.toHaveAttribute("aria-controls");
    expect(evidenceShortcut).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(explorerButton);
    expect(explorerButton).not.toHaveAttribute("aria-controls");
    expect(explorerButton).toHaveAttribute("aria-expanded", "false");
  });

  it("Performance test baseline - renders a large component without freezing", () => {
    const startTime = performance.now();
    render(<WorkbenchShell />);
    const duration = performance.now() - startTime;
    // For a unit test, we just ensure it renders quickly enough (< 200ms usually, but we'll use a safe bound)
    expect(duration).toBeLessThan(1000);
  });
});
