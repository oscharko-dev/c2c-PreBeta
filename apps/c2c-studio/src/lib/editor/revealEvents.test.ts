import { describe, expect, it, vi } from "vitest";

import {
  dispatchRevealCobol,
  dispatchRevealJava,
  REVEAL_COBOL_EVENT,
  REVEAL_JAVA_EVENT,
} from "./revealEvents";

describe("revealEvents", () => {
  it("dispatches the canonical COBOL reveal event shape", () => {
    const listener = vi.fn();
    window.addEventListener(REVEAL_COBOL_EVENT, listener);
    try {
      dispatchRevealCobol({ cobolFile: "PROG1.cbl", cobolLine: 15 });
      expect(listener).toHaveBeenCalledTimes(1);
      const event = listener.mock.calls[0]?.[0] as CustomEvent<unknown>;
      expect(event.detail).toEqual({
        cobolFile: "PROG1.cbl",
        cobolLine: 15,
      });
    } finally {
      window.removeEventListener(REVEAL_COBOL_EVENT, listener);
    }
  });

  it("dispatches the canonical Java reveal event shape", () => {
    const listener = vi.fn();
    window.addEventListener(REVEAL_JAVA_EVENT, listener);
    try {
      dispatchRevealJava({ javaFile: "Foo.java", javaLine: 8 });
      expect(listener).toHaveBeenCalledTimes(1);
      const event = listener.mock.calls[0]?.[0] as CustomEvent<unknown>;
      expect(event.detail).toEqual({ javaFile: "Foo.java", javaLine: 8 });
    } finally {
      window.removeEventListener(REVEAL_JAVA_EVENT, listener);
    }
  });
});
