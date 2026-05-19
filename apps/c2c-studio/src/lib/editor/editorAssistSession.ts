// Studio-IDE-10 (#249): per-page-load Studio correlation id for the
// Editor-Assist channel. The BFF owns budget enforcement through the
// authenticated session; this id is carried for UI correlation,
// telemetry, and ledger readability. A browser reload starts a new
// page-load id, while calls inside the same loaded Studio tab share one id.
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
  // strong, but this value is only a correlation id and not a secret.
  return `studio-editor-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
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
    // Browser privacy settings can block storage writes; the in-memory
    // cached id still keeps calls correlated for this page load.
  }
}

// Returns the Editor-Assist session id, creating one the first time it
// is requested in the current tab. Subsequent calls (across all editor
// panes) return the same id so telemetry, panel state, and ledger entries
// can be correlated across editors in this Studio page load.
export function getOrCreateEditorAssistSessionId(): string {
  if (cachedSessionId !== null) {
    return cachedSessionId;
  }
  const fresh = generateSessionId();
  cachedSessionId = fresh;
  // Persist for diagnostics within the loaded page only. The next reload
  // deliberately overwrites any old value instead of reusing it.
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
