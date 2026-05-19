/**
 * Studio-IDE-3 (#247): coverage for the "Clear local drafts" workflow in
 * AppTopBar. The persistence module is mocked because the production
 * implementation requires IndexedDB+WebCrypto; the tests verify the wiring
 * — menu open → confirm dialog → editorPersistence.clearAll(scope) call →
 * feedback toast — without re-exercising the persistence layer (which has
 * its own unit tests).
 */

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import React, { type ReactNode } from "react";

// Mock the editorPersistence module before anything imports it so the
// AppTopBar gets the stub. `vi.hoisted` keeps the mock fns accessible
// from inside the hoisted `vi.mock` factory while still letting tests
// reset them between cases.
const { clearAllMock, listDraftsMock, purgeExpiredMock, telemetryEmitMock } =
  vi.hoisted(() => ({
  clearAllMock: vi.fn(),
  listDraftsMock: vi.fn(),
  purgeExpiredMock: vi.fn(),
  telemetryEmitMock: vi.fn(),
}));
vi.mock("@/lib/editor/editorPersistence", () => {
  return {
    editorPersistence: {
      isAvailable: vi.fn(async () => true),
      saveDraft: vi.fn(),
      loadDraft: vi.fn(async () => null),
      purgeExpired: purgeExpiredMock,
      clearAll: clearAllMock,
      listDrafts: listDraftsMock,
    },
    getCurrentDraftScope: async () => ({
      tenantId: "tenant-A",
      userId: "user-1",
    }),
  };
});

vi.mock("@/lib/editor/editorTelemetry", () => ({
  emit: telemetryEmitMock,
}));

// Mock keyboard shortcuts hook so it does not install listeners we do
// not exercise.
vi.mock("@/hooks/useKeyboardShortcuts", () => ({
  useKeyboardShortcuts: vi.fn(),
}));

import { AppTopBar } from "@/components/workbench/AppTopBar";
import { SourceWorkspaceProvider } from "@/stores/sourceWorkspace";
import { TransformationRunProvider } from "@/stores/transformationRun";
import { WorkbenchProvider } from "@/stores/workbench";

const apiState = {
  health: { status: "ok" } as { status: string },
  mode: { orchestrator: "live", evidence: "live" } as {
    orchestrator: string;
    evidence: string;
  },
  error: null,
  errorKind: null,
  loading: false,
};

function renderTopBar() {
  return render(
    <Wrapper>
      <AppTopBar
        apiState={
          apiState as unknown as React.ComponentProps<
            typeof AppTopBar
          >["apiState"]
        }
      />
    </Wrapper>,
  );
}

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <WorkbenchProvider>
      <TransformationRunProvider>
        <SourceWorkspaceProvider>{children}</SourceWorkspaceProvider>
      </TransformationRunProvider>
    </WorkbenchProvider>
  );
}

describe("AppTopBar clear-local-drafts", () => {
  beforeEach(() => {
    clearAllMock.mockReset();
    listDraftsMock.mockReset();
    purgeExpiredMock.mockReset();
    telemetryEmitMock.mockReset();
    listDraftsMock.mockResolvedValue([]);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders the overflow menu hidden by default", () => {
    renderTopBar();
    expect(
      screen.queryByRole("menuitem", { name: /clear local drafts/i }),
    ).not.toBeInTheDocument();
  });

  it("opens the overflow menu when the More button is clicked", () => {
    renderTopBar();
    fireEvent.click(screen.getByLabelText(/more workbench actions/i));
    expect(
      screen.getByRole("menuitem", { name: /clear local drafts/i }),
    ).toBeInTheDocument();
  });

  it("opens the confirmation dialog and does NOT call clearAll until confirmed", () => {
    renderTopBar();
    fireEvent.click(screen.getByLabelText(/more workbench actions/i));
    fireEvent.click(
      screen.getByRole("menuitem", { name: /clear local drafts/i }),
    );
    expect(
      screen.getByRole("dialog", { name: /clear local drafts/i }),
    ).toBeInTheDocument();
    expect(clearAllMock).not.toHaveBeenCalled();
  });

  it("dismisses the confirmation dialog when Cancel is clicked", () => {
    renderTopBar();
    fireEvent.click(screen.getByLabelText(/more workbench actions/i));
    fireEvent.click(
      screen.getByRole("menuitem", { name: /clear local drafts/i }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(
      screen.queryByRole("dialog", { name: /clear local drafts/i }),
    ).not.toBeInTheDocument();
    expect(clearAllMock).not.toHaveBeenCalled();
  });

  it("invokes editorPersistence.clearAll with the current scope and surfaces the count", async () => {
    listDraftsMock.mockResolvedValueOnce([
      { kind: "cobol" },
      { kind: "java" },
      { kind: "java" },
    ]);
    clearAllMock.mockResolvedValueOnce({ purgedCount: 3 });
    renderTopBar();

    fireEvent.click(screen.getByLabelText(/more workbench actions/i));
    fireEvent.click(
      screen.getByRole("menuitem", { name: /clear local drafts/i }),
    );
    expect(await screen.findByText(/tenant tenant-a \/ user user-1/i)).toBeInTheDocument();
    expect(await screen.findByText(/3 local drafts/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear drafts" }));

    await waitFor(() => {
      expect(clearAllMock).toHaveBeenCalledTimes(1);
    });
    expect(clearAllMock).toHaveBeenCalledWith({
      tenantId: "tenant-A",
      userId: "user-1",
    });
    expect(telemetryEmitMock).toHaveBeenCalledWith({
      eventType: "drafts.cleared",
      payload: { purgedCountBucket: "lt_10" },
    });

    await waitFor(() => {
      expect(screen.getByText(/cleared 3 local drafts\./i)).toBeInTheDocument();
    });
  });

  it("reports a no-op when there were no drafts to clear", async () => {
    clearAllMock.mockResolvedValueOnce({ purgedCount: 0 });
    renderTopBar();

    fireEvent.click(screen.getByLabelText(/more workbench actions/i));
    fireEvent.click(
      screen.getByRole("menuitem", { name: /clear local drafts/i }),
    );
    expect(await screen.findByText(/0 local drafts/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear drafts" }));

    await waitFor(() => {
      expect(
        screen.getByText(/no local drafts to clear\./i),
      ).toBeInTheDocument();
    });
  });

  it("keeps the destructive confirm disabled when draft scope lookup fails", async () => {
    listDraftsMock.mockRejectedValueOnce(new Error("session expired"));
    renderTopBar();

    fireEvent.click(screen.getByLabelText(/more workbench actions/i));
    fireEvent.click(
      screen.getByRole("menuitem", { name: /clear local drafts/i }),
    );

    expect(
      await screen.findByText(/sign in again to clear local drafts/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear drafts" })).toBeDisabled();
    expect(clearAllMock).not.toHaveBeenCalled();
  });

  it("surfaces a recoverable error when clearAll fails", async () => {
    clearAllMock.mockRejectedValueOnce(new Error("quota"));
    renderTopBar();

    fireEvent.click(screen.getByLabelText(/more workbench actions/i));
    fireEvent.click(
      screen.getByRole("menuitem", { name: /clear local drafts/i }),
    );
    await screen.findByText(/0 local drafts/i);
    fireEvent.click(screen.getByRole("button", { name: "Clear drafts" }));

    expect(
      await screen.findByText(/unable to clear local drafts/i),
    ).toBeInTheDocument();
    expect(telemetryEmitMock).not.toHaveBeenCalled();
  });

  it("dismisses the confirmation dialog when Escape is pressed", () => {
    renderTopBar();
    fireEvent.click(screen.getByLabelText(/more workbench actions/i));
    fireEvent.click(
      screen.getByRole("menuitem", { name: /clear local drafts/i }),
    );
    expect(
      screen.getByRole("dialog", { name: /clear local drafts/i }),
    ).toBeInTheDocument();

    act(() => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(
      screen.queryByRole("dialog", { name: /clear local drafts/i }),
    ).not.toBeInTheDocument();
  });
});
