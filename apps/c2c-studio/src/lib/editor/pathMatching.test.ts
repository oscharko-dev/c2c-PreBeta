import { describe, expect, it } from "vitest";

import { pathBasename, pathSegments, pathSuffixMatches } from "./pathMatching";

describe("pathMatching", () => {
  it("splits mixed separators into path segments", () => {
    expect(pathSegments("src\\main/java//com/example/Foo.java")).toEqual([
      "src",
      "main",
      "java",
      "com",
      "example",
      "Foo.java",
    ]);
  });

  it("matches contiguous suffix segments only", () => {
    expect(
      pathSuffixMatches(
        "src/main/java/com/example/Foo.java",
        "build/generated/src/main/java/com/example/Foo.java",
      ),
    ).toBe(true);
    expect(
      pathSuffixMatches(
        "src/main/java/com/example/Foo.java",
        "build/generated/java/com/example/Bar.java",
      ),
    ).toBe(false);
  });

  it("returns false when either side has no segments", () => {
    expect(pathSuffixMatches("", "Foo.java")).toBe(false);
    expect(pathSuffixMatches("Foo.java", "")).toBe(false);
  });

  it("lowercases the basename for program-id fallback comparisons", () => {
    expect(pathBasename("workspace/PROG1.CBL")).toBe("prog1.cbl");
  });
});
