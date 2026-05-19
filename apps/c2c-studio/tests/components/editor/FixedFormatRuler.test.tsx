import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  FixedFormatRuler,
  FixedFormatRulerToggle,
} from "@/components/editor/FixedFormatRuler";

describe("FixedFormatRuler", () => {
  it("renders all COBOL fixed-format zones from the shared bounds", () => {
    render(<FixedFormatRuler />);

    expect(screen.getByRole("img")).toHaveAccessibleName(
      /COBOL fixed-format column zones/i,
    );
    expect(screen.getByText("Seq 1-6")).toHaveAttribute(
      "data-zone",
      "sequence",
    );
    expect(screen.getByText("I 7")).toHaveAttribute("data-start", "7");
    expect(screen.getByText("A 8-11")).toHaveAttribute("data-end", "11");
    expect(screen.getByText("B 12-72")).toHaveAttribute("data-end", "72");
    expect(screen.getByText("Id 73-80")).toHaveAttribute(
      "data-zone",
      "identification",
    );
  });

  it("reports toggle state and emits the next enabled value", () => {
    const onToggle = vi.fn();
    const { rerender } = render(
      <FixedFormatRulerToggle enabled={false} onToggle={onToggle} />,
    );

    const toggle = screen.getByRole("switch", {
      name: /toggle COBOL fixed-format ruler/i,
    });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    fireEvent.click(toggle);
    expect(onToggle).toHaveBeenCalledWith(true);

    rerender(<FixedFormatRulerToggle enabled={true} onToggle={onToggle} />);
    expect(toggle).toHaveAttribute("aria-checked", "true");
    fireEvent.click(toggle);
    expect(onToggle).toHaveBeenLastCalledWith(false);
  });
});
