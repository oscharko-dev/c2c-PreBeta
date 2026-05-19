import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const STUDIO_ROOT = resolve(__dirname, "..", "..");
const DEMO_PAGE_PATH = resolve(
  STUDIO_ROOT,
  "src/app/(__dev)/code-editor-demo/page.tsx",
);

const pageSource = readFileSync(DEMO_PAGE_PATH, "utf8");

describe("code-editor-demo dev route", () => {
  it("stays dynamic and returns notFound in production builds", () => {
    expect(pageSource).toMatch(/export const dynamic = ["']force-dynamic["']/);
    expect(pageSource).toMatch(
      /process\.env\.NODE_ENV === ["']production["'][\s\S]*?notFound\(\)/,
    );
  });
});
