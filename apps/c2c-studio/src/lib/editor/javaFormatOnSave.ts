// Studio-IDE-14 (#256): persistent toggle for "Format Java on Save". The
// preference lives in LocalStorage (not IndexedDB) because it is a UI
// affordance: small, non-sensitive, and read on every Cmd/Ctrl+S so a
// synchronous backend keeps the keybinding latency-free.
//
// LocalStorage may throw in private-browsing modes; we treat any error
// from the platform as "preference unavailable, fall through to false"
// rather than letting it block the editor.

const STORAGE_KEY = "c2c:formatJavaOnSave";

// `safeStorage` is structurally compatible with the WHATWG Storage type
// but lets us inject a fake in tests. The module-level singleton uses
// `globalThis.localStorage` when present, otherwise a no-op shim so the
// rest of the API never throws.
export interface JavaFormatOnSaveStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

let storageOverride: JavaFormatOnSaveStorage | null = null;

function resolveStorage(): JavaFormatOnSaveStorage | null {
  if (storageOverride) {
    return storageOverride;
  }
  if (typeof globalThis === "undefined") {
    return null;
  }
  try {
    const candidate = (globalThis as { localStorage?: JavaFormatOnSaveStorage })
      .localStorage;
    if (!candidate) {
      return null;
    }
    // Probe the API once — private-browsing mode in Safari historically
    // returned a present `localStorage` whose `setItem` raised on every
    // call. The probe lets us downgrade gracefully without surprising
    // the editor mid-keystroke.
    const probeKey = "__c2c_format_on_save_probe__";
    candidate.setItem(probeKey, "1");
    candidate.removeItem(probeKey);
    return candidate;
  } catch {
    return null;
  }
}

// Test seam: replace the underlying storage. Pass `null` to restore the
// default (browser localStorage).
export function __setJavaFormatOnSaveStorage(
  storage: JavaFormatOnSaveStorage | null,
): void {
  storageOverride = storage;
}

// Read the current preference. Defaults to `false` if storage is
// unavailable or the value is missing/unexpected.
export function getJavaFormatOnSave(): boolean {
  const storage = resolveStorage();
  if (!storage) return false;
  try {
    return storage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

// Persist the preference. Silently no-ops when storage is unavailable —
// the editor still works, the toggle just does not survive a reload.
export function setJavaFormatOnSave(enabled: boolean): void {
  const storage = resolveStorage();
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, enabled ? "true" : "false");
  } catch {
    // Quota exceeded / private-browsing — same fallthrough as resolve.
  }
}

// Internal key exposed for tests so they can assert the storage shape
// without hard-coding the literal in multiple places.
export const JAVA_FORMAT_ON_SAVE_STORAGE_KEY = STORAGE_KEY;
