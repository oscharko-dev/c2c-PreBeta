import { afterEach, describe, expect, it } from "vitest";

import {
  JAVA_FORMAT_ON_SAVE_STORAGE_KEY,
  __setJavaFormatOnSaveStorage,
  getJavaFormatOnSave,
  setJavaFormatOnSave,
} from "./javaFormatOnSave";

interface FakeStorage {
  store: Record<string, string>;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function createFakeStorage(): FakeStorage {
  const store: Record<string, string> = {};
  return {
    store,
    getItem(key) {
      return Object.prototype.hasOwnProperty.call(store, key)
        ? (store[key] ?? null)
        : null;
    },
    setItem(key, value) {
      store[key] = value;
    },
    removeItem(key) {
      delete store[key];
    },
  };
}

describe("javaFormatOnSave preference", () => {
  afterEach(() => {
    __setJavaFormatOnSaveStorage(null);
    if (typeof globalThis !== "undefined" && globalThis.localStorage) {
      globalThis.localStorage.removeItem(JAVA_FORMAT_ON_SAVE_STORAGE_KEY);
    }
  });

  it("defaults to false when no value is stored", () => {
    const storage = createFakeStorage();
    __setJavaFormatOnSaveStorage(storage);
    expect(getJavaFormatOnSave()).toBe(false);
  });

  it("persists `true` as the canonical string", () => {
    const storage = createFakeStorage();
    __setJavaFormatOnSaveStorage(storage);
    setJavaFormatOnSave(true);
    expect(storage.store[JAVA_FORMAT_ON_SAVE_STORAGE_KEY]).toBe("true");
    expect(getJavaFormatOnSave()).toBe(true);
  });

  it("persists `false` explicitly so an earlier `true` is overridden", () => {
    const storage = createFakeStorage();
    __setJavaFormatOnSaveStorage(storage);
    setJavaFormatOnSave(true);
    setJavaFormatOnSave(false);
    expect(getJavaFormatOnSave()).toBe(false);
    expect(storage.store[JAVA_FORMAT_ON_SAVE_STORAGE_KEY]).toBe("false");
  });

  it("treats malformed stored values as false", () => {
    const storage = createFakeStorage();
    storage.store[JAVA_FORMAT_ON_SAVE_STORAGE_KEY] = "yes";
    __setJavaFormatOnSaveStorage(storage);
    expect(getJavaFormatOnSave()).toBe(false);
  });

  it("survives storage throws gracefully", () => {
    const throwingStorage: FakeStorage = {
      ...createFakeStorage(),
      getItem() {
        throw new Error("quota exceeded");
      },
      setItem() {
        throw new Error("quota exceeded");
      },
    };
    __setJavaFormatOnSaveStorage(throwingStorage);
    expect(() => setJavaFormatOnSave(true)).not.toThrow();
    expect(getJavaFormatOnSave()).toBe(false);
  });
});
