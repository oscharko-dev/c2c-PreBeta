import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  __resetEditorAssistSessionIdForTests,
  getOrCreateEditorAssistSessionId,
} from "./editorAssistSession";

const STORAGE_KEY = "c2c.editor.sessionId";

beforeEach(() => {
  __resetEditorAssistSessionIdForTests();
  window.sessionStorage.clear();
});

afterEach(() => {
  __resetEditorAssistSessionIdForTests();
  window.sessionStorage.clear();
});

describe("getOrCreateEditorAssistSessionId", () => {
  it("returns one stable id inside a loaded page", () => {
    const first = getOrCreateEditorAssistSessionId();
    const second = getOrCreateEditorAssistSessionId();

    expect(first).toBeTruthy();
    expect(second).toBe(first);
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBe(first);
  });

  it("does not reuse a stale id left in sessionStorage by a previous reload", () => {
    window.sessionStorage.setItem(STORAGE_KEY, "stale-session-id");

    const fresh = getOrCreateEditorAssistSessionId();

    expect(fresh).not.toBe("stale-session-id");
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBe(fresh);
  });
});
