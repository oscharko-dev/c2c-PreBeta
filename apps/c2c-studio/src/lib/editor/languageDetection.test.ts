import { describe, expect, it } from "vitest";

import {
  detectLanguageFromPath,
  isEditableLanguage,
} from "./languageDetection";

describe("detectLanguageFromPath", () => {
  it("maps .java to java", () => {
    expect(detectLanguageFromPath("src/main/java/App.java")).toBe("java");
  });

  it("maps .json to json", () => {
    expect(detectLanguageFromPath("manifest.json")).toBe("json");
  });

  it("maps .xml to xml", () => {
    expect(detectLanguageFromPath("pom.xml")).toBe("xml");
  });

  it("maps .md and .markdown to markdown", () => {
    expect(detectLanguageFromPath("README.md")).toBe("markdown");
    expect(detectLanguageFromPath("CHANGELOG.markdown")).toBe("markdown");
  });

  it("is case-insensitive on the extension", () => {
    expect(detectLanguageFromPath("App.JAVA")).toBe("java");
    expect(detectLanguageFromPath("Config.JSON")).toBe("json");
  });

  it("ignores leading path segments", () => {
    expect(detectLanguageFromPath("src/main/java/com/foo/Bar.java")).toBe(
      "java",
    );
    expect(detectLanguageFromPath("src\\windows\\path\\file.xml")).toBe("xml");
  });

  it("falls back to plaintext for unknown extensions", () => {
    expect(detectLanguageFromPath("script.sh")).toBe("plaintext");
    expect(detectLanguageFromPath("data.bin")).toBe("plaintext");
  });

  it("falls back to plaintext for extensionless files", () => {
    expect(detectLanguageFromPath("Dockerfile")).toBe("plaintext");
    expect(detectLanguageFromPath("Makefile")).toBe("plaintext");
  });

  it("treats a dotfile with no further extension as plaintext", () => {
    expect(detectLanguageFromPath(".gitignore")).toBe("plaintext");
    expect(detectLanguageFromPath("/path/to/.env")).toBe("plaintext");
  });

  it("treats a trailing dot as plaintext rather than an empty extension", () => {
    expect(detectLanguageFromPath("App.")).toBe("plaintext");
  });

  it("returns plaintext for null / undefined / empty input", () => {
    expect(detectLanguageFromPath(null)).toBe("plaintext");
    expect(detectLanguageFromPath(undefined)).toBe("plaintext");
    expect(detectLanguageFromPath("")).toBe("plaintext");
  });
});

describe("isEditableLanguage", () => {
  it("is true only for java", () => {
    expect(isEditableLanguage("java")).toBe(true);
  });

  it("is false for every non-java language", () => {
    expect(isEditableLanguage("json")).toBe(false);
    expect(isEditableLanguage("xml")).toBe(false);
    expect(isEditableLanguage("markdown")).toBe(false);
    expect(isEditableLanguage("plaintext")).toBe(false);
  });
});
