import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const STUDIO_ROOT = resolve(__dirname, "..", "..");
const SCRIPT_PATH = join(STUDIO_ROOT, "scripts", "verify-monaco-lazy.mjs");

interface FakeBuild {
  studioRoot: string;
  cleanup: () => void;
}

function setupFakeBuild(options: {
  firstLoadContent: string;
  lazyContent: string;
}): FakeBuild {
  const root = mkdtempSync(join(tmpdir(), "verify-monaco-lazy-"));
  // Place the studio shape: root contains scripts/ and .next/
  mkdirSync(join(root, "scripts"), { recursive: true });
  // Copy (link) the script via filesystem copy so the script's resolution of
  // `..` (studio root) works against the fake tree.
  const scriptContent = readFileSync(SCRIPT_PATH, "utf8");
  writeFileSync(join(root, "scripts", "verify-monaco-lazy.mjs"), scriptContent);

  mkdirSync(join(root, ".next", "diagnostics"), { recursive: true });
  mkdirSync(join(root, ".next", "static", "chunks"), { recursive: true });

  writeFileSync(
    join(root, ".next", "static", "chunks", "first-load.js"),
    options.firstLoadContent,
  );
  writeFileSync(
    join(root, ".next", "static", "chunks", "lazy.js"),
    options.lazyContent,
  );

  const stats = [
    {
      route: "/",
      firstLoadUncompressedJsBytes: options.firstLoadContent.length,
      firstLoadChunkPaths: [".next/static/chunks/first-load.js"],
    },
  ];
  writeFileSync(
    join(root, ".next", "diagnostics", "route-bundle-stats.json"),
    JSON.stringify(stats),
  );

  return {
    studioRoot: root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function runVerify(studioRoot: string): {
  status: number;
  stdout: string;
  stderr: string;
} {
  try {
    const stdout = execFileSync(
      process.execPath,
      [join(studioRoot, "scripts", "verify-monaco-lazy.mjs")],
      { encoding: "utf8" },
    );
    return { status: 0, stdout, stderr: "" };
  } catch (e) {
    const err = e as {
      status?: number;
      stdout?: Buffer | string;
      stderr?: Buffer | string;
    };
    return {
      status: typeof err.status === "number" ? err.status : 1,
      stdout:
        typeof err.stdout === "string"
          ? err.stdout
          : (err.stdout?.toString("utf8") ?? ""),
      stderr:
        typeof err.stderr === "string"
          ? err.stderr
          : (err.stderr?.toString("utf8") ?? ""),
    };
  }
}

describe("verify-monaco-lazy regex tightening (#258 Copilot review)", () => {
  it("does NOT flag a first-load chunk that mentions 'monaco-editor' only as an incidental string", () => {
    // Bare-word mention that the previous substring matcher would have caught.
    const firstLoadContent = `
      // license: "monaco-editor: MIT, see https://example.com"
      // commentary: monaco-editor was once vendored here but no longer is.
      const greeting = "hello world";
    `;
    const lazyContent = `
      // Realistic webpack/turbopack module reference shape:
      "./node_modules/monaco-editor/esm/vs/editor/editor.api.js"
    `;
    const fake = setupFakeBuild({ firstLoadContent, lazyContent });
    try {
      const result = runVerify(fake.studioRoot);
      expect(result.stderr).not.toContain("Monaco is statically reachable");
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("OK");
    } finally {
      fake.cleanup();
    }
  });

  it("DOES flag a first-load chunk that imports monaco-editor as a module", () => {
    const firstLoadContent = `
      import * as m from "monaco-editor";
      console.log(m);
    `;
    const lazyContent = `
      "./node_modules/monaco-editor/esm/vs/editor/editor.api.js"
    `;
    const fake = setupFakeBuild({ firstLoadContent, lazyContent });
    try {
      const result = runVerify(fake.studioRoot);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Monaco is statically reachable");
    } finally {
      fake.cleanup();
    }
  });

  it("DOES flag a first-load chunk that references the ESM subpath", () => {
    const firstLoadContent = `
      "./node_modules/monaco-editor/esm/vs/editor/editor.worker.js"
    `;
    const lazyContent = `
      "./node_modules/monaco-editor/esm/vs/editor/editor.api.js"
    `;
    const fake = setupFakeBuild({ firstLoadContent, lazyContent });
    try {
      const result = runVerify(fake.studioRoot);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Monaco is statically reachable");
    } finally {
      fake.cleanup();
    }
  });

  it("requires the build manifest to exist", () => {
    const root = mkdtempSync(join(tmpdir(), "verify-monaco-lazy-empty-"));
    try {
      mkdirSync(join(root, "scripts"), { recursive: true });
      const scriptContent = readFileSync(SCRIPT_PATH, "utf8");
      writeFileSync(
        join(root, "scripts", "verify-monaco-lazy.mjs"),
        scriptContent,
      );
      // No .next/ at all.
      const result = runVerify(root);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Build diagnostics not found");
      expect(existsSync(join(root, ".next"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
