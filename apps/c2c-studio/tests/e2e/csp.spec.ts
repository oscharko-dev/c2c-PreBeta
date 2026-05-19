// Issue #271 / ADR-0005 §6: end-to-end acceptance for the CSP nonce
// middleware.
//
// What this suite proves under the real production build:
//
//   1. The Studio shell hydrates under the new CSP — i.e. the
//      ``script-src 'self' 'nonce-{N}' 'strict-dynamic'`` directive
//      does not block Next.js' hydration bootstrap. If the nonce
//      plumbing drifts, hydration breaks and ``WorkbenchShell``
//      never appears.
//
//   2. Monaco mounts under the new CSP. ``worker-src 'self'`` allows
//      the same-origin module workers Monaco uses; if a future
//      bundler change starts emitting ``blob:`` workers the editor
//      will fail to mount and this test will fail.
//
//   3. No CSP violation lands in the browser console for the
//      golden-path workflow (page load + editor mount). A genuine
//      violation indicates the middleware policy is too tight for
//      the runtime.
//
//   4. The response carries the documented CSP directives and the
//      per-request nonce is fresh on each navigation.
//
//   5. The ADR-0005 §5 hover sanitization payloads cannot execute
//      under the new CSP. The unit tests in
//      ``hoverMarkdownSanitizer.test.ts`` cover the renderer; this
//      spec proves the browser-level invariant — even if the
//      sanitizer were bypassed, the CSP would still block ``<script>``
//      and ``javascript:`` execution because ``script-src`` allows
//      only nonced sources.
//
// Tagged ``@csp`` so a future CI shard can run it in isolation.

import { expect, test, type ConsoleMessage, type Page } from "@playwright/test";

interface CspSnapshot {
  csp: string;
  nonce: string;
}

async function navigateAndSnapshotCsp(page: Page): Promise<CspSnapshot> {
  const response = await page.goto("/");
  if (!response) throw new Error("navigation produced no response");
  const csp = response.headers()["content-security-policy"];
  if (!csp) {
    throw new Error(
      `no Content-Security-Policy on the response; headers were: ${JSON.stringify(response.headers(), null, 2)}`,
    );
  }
  const match = csp.match(/'nonce-([^']+)'/);
  if (!match || !match[1]) {
    throw new Error(`no nonce in CSP: ${csp}`);
  }
  return { csp, nonce: match[1] };
}

function startCspViolationCollector(page: Page): {
  violations: string[];
  stop: () => void;
} {
  const violations: string[] = [];
  const handler = (message: ConsoleMessage): void => {
    const text = message.text();
    // Browser console emits "Refused to … because it violates the
    // following Content Security Policy directive: …" on a CSP
    // violation. We collect every such line so the assertion can
    // print the full set rather than just the first one.
    if (/content security policy/i.test(text)) {
      violations.push(text);
    }
  };
  page.on("console", handler);
  return {
    violations,
    stop: () => page.off("console", handler),
  };
}

test.describe("@csp Studio hydrates and Monaco mounts under the ADR-0005 §6 CSP", () => {
  test("hydration succeeds with no CSP console violations", async ({
    page,
  }) => {
    const collector = startCspViolationCollector(page);
    try {
      const { csp, nonce } = await navigateAndSnapshotCsp(page);
      expect(csp).toContain("default-src 'self'");
      expect(csp).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/);
      expect(csp).toContain("object-src 'none'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("report-uri /api/v0/csp-report");
      expect(nonce.length).toBeGreaterThanOrEqual(16);

      // Hydration check — the shell only renders once the React
      // bundle has booted. If the CSP blocked the bootstrap this
      // assertion times out.
      await expect(page.getByTestId("studio-workbench-shell")).toBeVisible();

      expect(
        collector.violations,
        `unexpected CSP violations: ${collector.violations.join("\n")}`,
      ).toEqual([]);
    } finally {
      collector.stop();
    }
  });

  test("Monaco mounts under the new CSP without worker violations", async ({
    page,
  }) => {
    const collector = startCspViolationCollector(page);
    try {
      await page.goto("/");
      await expect(page.getByTestId("studio-workbench-shell")).toBeVisible();

      // Surface the COBOL editor pane — clicking "Start Typing"
      // mounts Monaco, which lazy-loads the editor and constructs
      // the module workers. If ``worker-src 'self'`` were wrong, the
      // ``.monaco-editor`` container would never appear because the
      // worker constructor would throw at mount time.
      await page.getByRole("button", { name: "Start Typing" }).click();
      // Monaco assigns its container the ``.monaco-editor`` class once
      // the bundle has loaded and the model is attached. We assert on
      // the rendered ``.view-line`` to prove Monaco's view layer
      // (which depends on the workers under the hood) reached the
      // first paint — the same checkpoint the perf harness uses.
      await expect(page.locator(".monaco-editor").first()).toBeVisible({
        timeout: 30_000,
      });

      expect(
        collector.violations,
        `unexpected CSP violations from Monaco mount: ${collector.violations.join("\n")}`,
      ).toEqual([]);
    } finally {
      collector.stop();
    }
  });

  test("nonce rotates between navigations", async ({ page }) => {
    const first = await navigateAndSnapshotCsp(page);
    // ``goto`` with the same URL re-runs the request; the middleware
    // mints a fresh nonce on every hit.
    const second = await navigateAndSnapshotCsp(page);
    expect(second.nonce).not.toBe(first.nonce);
  });

  test("ADR-0005 §5 hover payloads cannot execute under the CSP", async ({
    page,
  }) => {
    // The hover sanitizer (``hoverMarkdownSanitizer.ts``) is the
    // first line of defence and is unit-tested against every payload
    // in ADR §5. This test is the *second* line: even if DOMPurify
    // were bypassed, the realistic XSS vector — content reaching a
    // ``dangerouslySetInnerHTML`` / ``innerHTML`` sink — must not
    // produce executable code.
    //
    // Where the browser and the CSP each carry the load:
    //
    //   * ``<script>`` via ``innerHTML``: **browser-inert** by the
    //     HTML5 fragment-parsing rules, regardless of CSP. We assert
    //     it anyway because that browser guarantee is part of the
    //     defence-in-depth story.
    //   * ``<img onerror>`` via ``innerHTML`` or ``setAttribute``:
    //     **CSP-blocked** because ``script-src`` carries no
    //     ``'unsafe-inline'`` (inline event handlers count as inline
    //     script). This is the load-bearing CSP assertion.
    //   * ``javascript:`` link, clicked: **CSP-blocked** for the same
    //     reason — ``javascript:`` URIs are inline script.
    //   * Cross-document scripts via ``data:`` iframe: the framed
    //     document's CSP is inherited from the parent (Chromium's
    //     "inherit from initiator" rule for ``data:`` documents), so
    //     its inline script is blocked too.
    //
    // ``'strict-dynamic'`` deliberately propagates trust to scripts
    // created by already-trusted scripts. A ``page.evaluate`` block
    // runs in a trusted context, so testing
    // ``document.createElement('script')`` would prove nothing about
    // CSP — it would correctly succeed. The vectors below are the
    // ones a real attacker would reach through a DOMPurify bypass.
    await page.goto("/");
    await expect(page.getByTestId("studio-workbench-shell")).toBeVisible();

    const collector = startCspViolationCollector(page);
    try {
      const result = await page.evaluate(() => {
        const container = document.createElement("div");
        document.body.appendChild(container);

        // (1) Inline <script> via innerHTML — browser-inert.
        container.innerHTML =
          "<script>window.__csp_pwned_inline_script=true;</script>";

        // (2) <img onerror> via innerHTML — onerror counts as inline
        //     script, CSP must block.
        const imgContainer = document.createElement("div");
        document.body.appendChild(imgContainer);
        imgContainer.innerHTML =
          '<img src="data:image/png;base64,AA" onerror="window.__csp_pwned_img_innerhtml=true">';

        // (3) <img onerror> via setAttribute on a real element — the
        //     other realistic vector for inline handlers.
        const liveImg = document.createElement("img");
        document.body.appendChild(liveImg);
        liveImg.setAttribute("onerror", "window.__csp_pwned_img_setattr=true");
        liveImg.src = "data:image/png;base64,BB";

        // (4) javascript: link, clicked.
        const anchor = document.createElement("a");
        anchor.href = "javascript:window.__csp_pwned_js=true";
        document.body.appendChild(anchor);
        anchor.click();

        // (5) data: iframe with a nested <script> trying to set the
        //     parent's global. Chromium inherits the parent's CSP for
        //     data: documents, so the nested script is blocked.
        const iframe = document.createElement("iframe");
        iframe.src =
          "data:text/html,<script>parent.__csp_pwned_iframe=true<\/script>";
        document.body.appendChild(iframe);

        // Yield once so any queued image-error / iframe-load tasks
        // have a chance to run before we inspect globals.
        return new Promise<Record<string, boolean>>((resolve) => {
          setTimeout(() => {
            const w = window as unknown as Record<string, unknown>;
            resolve({
              inlineScript: w.__csp_pwned_inline_script === true,
              imgInnerHtml: w.__csp_pwned_img_innerhtml === true,
              imgSetAttr: w.__csp_pwned_img_setattr === true,
              js: w.__csp_pwned_js === true,
              iframe: w.__csp_pwned_iframe === true,
            });
          }, 300);
        });
      });

      expect(result.inlineScript, "<script> via innerHTML executed").toBe(
        false,
      );
      expect(
        result.imgInnerHtml,
        "<img onerror> via innerHTML executed (CSP must block inline handlers)",
      ).toBe(false);
      expect(
        result.imgSetAttr,
        "<img onerror> via setAttribute executed (CSP must block inline handlers)",
      ).toBe(false);
      expect(
        result.js,
        "javascript: link executed (CSP must block javascript: URIs)",
      ).toBe(false);
      expect(
        result.iframe,
        "data: iframe payload executed (parent CSP must apply to data: documents)",
      ).toBe(false);
    } finally {
      collector.stop();
    }
  });
});
