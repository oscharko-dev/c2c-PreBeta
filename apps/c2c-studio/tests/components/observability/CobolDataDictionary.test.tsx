import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CobolDataDictionary } from "@/components/observability/CobolDataDictionary";

const { sourceWorkspaceState } = vi.hoisted(() => ({
  sourceWorkspaceState: { sourceText: "" },
}));

// The component reads `sourceText` from `useSourceWorkspace` when no
// override is supplied. Mocking the hook keeps the test free of the
// full SourceWorkspaceProvider boot path.
vi.mock("@/stores/sourceWorkspace", () => ({
  useSourceWorkspace: () => sourceWorkspaceState,
}));

const FIXTURE = [
  "       IDENTIFICATION DIVISION.",
  "       PROGRAM-ID. SAMPLE.",
  "       DATA DIVISION.",
  "       WORKING-STORAGE SECTION.",
  "       01 WS-COUNTER       PIC 99 VALUE 1.",
  "       01 WS-TOTAL         PIC S9(5)V99 USAGE COMP-3 VALUE 0.",
  "       01 WS-NAME          PIC X(20) VALUE 'ALICE'.",
  "       01 WS-TABLE.",
  "          05 WS-CELL       PIC 9(3) OCCURS 10 TIMES.",
  "       01 WS-ALIAS REDEFINES WS-TABLE.",
  "          05 WS-VIEW       PIC X(30).",
  "       PROCEDURE DIVISION.",
  "           STOP RUN.",
].join("\n");

describe("CobolDataDictionary", () => {
  beforeEach(() => {
    sourceWorkspaceState.sourceText = "";
  });

  it("renders an empty-state hint when no source is loaded", () => {
    render(<CobolDataDictionary />);
    expect(
      screen.getByTestId("cobol-data-dictionary-empty"),
    ).toBeInTheDocument();
  });

  it("lists every recognised data item from the supplied source", () => {
    render(<CobolDataDictionary sourceTextOverride={FIXTURE} />);
    const rows = screen.getAllByTestId("cobol-data-dictionary-item");
    expect(rows).toHaveLength(7);
    expect(screen.getAllByText(/WS-COUNTER/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/WS-TOTAL/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/WS-ALIAS/).length).toBeGreaterThan(0);
  });

  it("lists data items from the production source workspace path", () => {
    sourceWorkspaceState.sourceText = FIXTURE;
    render(<CobolDataDictionary />);
    expect(screen.getAllByTestId("cobol-data-dictionary-item")).toHaveLength(7);
    expect(screen.getAllByText(/WS-TOTAL/).length).toBeGreaterThan(0);
  });

  it("renders a PIC summary line for items that declare a picture", () => {
    render(<CobolDataDictionary sourceTextOverride={FIXTURE} />);
    expect(screen.getByText(/PIC S9\(5\)V99/)).toBeInTheDocument();
    expect(screen.getAllByText(/COMP-3/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/OCCURS 10 TIMES/).length).toBeGreaterThan(0);
  });

  it("renders a REDEFINES summary for alias items", () => {
    render(<CobolDataDictionary sourceTextOverride={FIXTURE} />);
    expect(screen.getByText(/REDEFINES WS-TABLE/)).toBeInTheDocument();
  });

  it("renders sanitized markdown summary content with hover parity details", () => {
    const { container } = render(
      <CobolDataDictionary sourceTextOverride={FIXTURE} />,
    );
    expect(
      screen.getAllByText(/java\.math\.BigDecimal/).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText(/W0 assumption/)).toBeInTheDocument();
    expect(container.querySelector("strong code")).not.toBeNull();
    expect(container).not.toHaveTextContent(/\*\*/);
  });

  it("renders the no-items hint when the source has no DATA DIVISION entries", () => {
    const noData = [
      "       IDENTIFICATION DIVISION.",
      "       PROGRAM-ID. SAMPLE.",
      "       PROCEDURE DIVISION.",
      "           STOP RUN.",
    ].join("\n");
    render(<CobolDataDictionary sourceTextOverride={noData} />);
    expect(
      screen.getByTestId("cobol-data-dictionary-no-items"),
    ).toBeInTheDocument();
  });
});
