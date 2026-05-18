// Studio-IDE-10 (#249): per-page-load session id for the Editor-Assist
// channel. The BFF treats this id as the budget key — one budget per
// `(tenantId, userId, sessionId)` triple. Generating a fresh id on
// every cold load lines up with the slice contract: the Explain budget
// resets when the user reloads Studio. ``sessionStorage`` is the
// natural store because it is per-tab and clears on tab close.
//
// In SSR or test environments without ``sessionStorage`` we fall back
// to an in-memory id so callers still get a stable value within the
// same JavaScript process.

const SESSION_STORAGE_KEY = "c2c.editor.sessionId" as const;

let cachedSessionId: string | null = null;

function generateSessionId(): string {
  // Prefer Web Crypto's UUID when available — that covers every
  // browser the Studio supports plus Node ≥19. In older Node test
  // environments we fall back to a hex string assembled from
  // ``crypto.getRandomValues`` so the id remains 128 bits of entropy.
  const cryptoObj =
    typeof globalThis !== "undefined" ? globalThis.crypto : undefined;
  if (cryptoObj && typeof cryptoObj.randomUUID === "function") {
    return cryptoObj.randomUUID();
  }
  if (cryptoObj && typeof cryptoObj.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    cryptoObj.getRandomValues(bytes);
    let hex = "";
    for (let i = 0; i < bytes.length; i += 1) {
      hex += bytes[i].toString(16).padStart(2, "0");
    }
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  // Final defensive fallback. ``Math.random`` is not cryptographically
  // strong but the session id is a budget key, not a secret.
  return `studio-editor-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}

function readFromSessionStorage(): string | null {
  if (
    typeof window === "undefined" ||
    typeof window.sessionStorage === "undefined"
  ) {
    return null;
  }
  try {
    return window.sessionStorage.getItem(SESSION_STORAGE_KEY);
  } catch {
    // Safari private mode + some browser policies throw on
    // ``sessionStorage`` access. We treat any throw as "no value".
    return null;
  }
}

function writeToSessionStorage(value: string): void {
  if (
    typeof window === "undefined" ||
    typeof window.sessionStorage === "undefined"
  ) {
    return;
  }
  try {
    window.sessionStorage.setItem(SESSION_STORAGE_KEY, value);
  } catch {
    // Same defensive swallow as the read path.
  }
}

// Returns the Editor-Assist session id, creating one the first time it
// is requested in the current tab. Subsequent calls (across all editor
// panes) return the same id so a single budget bucket covers every
// Explain invocation from this Studio tab.
export function getOrCreateEditorAssistSessionId(): string {
  if (cachedSessionId !== null) {
    return cachedSessionId;
  }
  const existing = readFromSessionStorage();
  if (existing !== null && existing.length > 0) {
    cachedSessionId = existing;
    return existing;
  }
  const fresh = generateSessionId();
  cachedSessionId = fresh;
  writeToSessionStorage(fresh);
  return fresh;
}

// Test-only escape hatch — resets the cached id so a vitest case can
// assert generation from a clean state without juggling
// ``sessionStorage`` directly.
export function __resetEditorAssistSessionIdForTests(): void {
  cachedSessionId = null;
  if (
    typeof window !== "undefined" &&
    typeof window.sessionStorage !== "undefined"
  ) {
    try {
      window.sessionStorage.removeItem(SESSION_STORAGE_KEY);
    } catch {
      // ignored
    }
  }
}
