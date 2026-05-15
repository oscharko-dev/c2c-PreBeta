# W0 Corrective Epic #86 Closure Evidence

Issue [#86](https://github.com/oscharko-dev/c2c-PreBeta/issues/86)
is the corrective Wave 0 epic for turning the repository from service-level
building blocks into a browser-visible COBOL-to-Java application path.

This document records the closure evidence for the epic. It does not replace
the release gate in [`w0-release-gate.md`](w0-release-gate.md); it ties the
epic's child work back to that gate so reviewers can re-derive the result from
a clean checkout.

## Closure Decision

The Issue #86 product path is satisfied when the current `dev` branch provides:

- one-command local startup for the product stack;
- a browser Studio where COBOL source is loaded or edited in the left pane;
- a Start action that creates a BFF/orchestrator-backed run;
- generated Java displayed from persisted run artifacts, not from placeholder UI data;
- build/test, equivalence, Evidence Pack, run artifact, Harness, model governance,
  and Experience Learning surfaces for the active run;
- explicit blocked, unsupported, incomplete, and unavailable states instead of
  silent product-mode fallback;
- automated browser acceptance coverage that fails if successful output is hard-coded
  or disconnected from BFF artifacts.

## Child Issue Audit

The original corrective child issues are complete on `dev`:

| Issue | Closure evidence |
|-------|------------------|
| [#84](https://github.com/oscharko-dev/c2c-PreBeta/issues/84) | Portable GnuCOBOL runtime reproduction. |
| [#87](https://github.com/oscharko-dev/c2c-PreBeta/issues/87) | Real `sourceText` application run API. |
| [#90](https://github.com/oscharko-dev/c2c-PreBeta/issues/90) | One-command local product launcher. |
| [#91](https://github.com/oscharko-dev/c2c-PreBeta/issues/91) | UI-started runs route through the orchestrator as Harness consumer. |
| [#89](https://github.com/oscharko-dev/c2c-PreBeta/issues/89) | Run artifacts are persisted and exposed by run id. |
| [#92](https://github.com/oscharko-dev/c2c-PreBeta/issues/92) | Executable COBOL oracle support for UI-provided source. |
| [#88](https://github.com/oscharko-dev/c2c-PreBeta/issues/88) | Editable COBOL-to-Java workbench. |
| [#85](https://github.com/oscharko-dev/c2c-PreBeta/issues/85) | UI/BFF panels use real generated/build/evidence artifacts. |
| [#93](https://github.com/oscharko-dev/c2c-PreBeta/issues/93) | Product mode rejects placeholder execution paths. |
| [#94](https://github.com/oscharko-dev/c2c-PreBeta/issues/94) | Selectable reference programs align to supported product execution. |
| [#97](https://github.com/oscharko-dev/c2c-PreBeta/issues/97) | Generated Java is exposed as inspectable project artifacts. |
| [#96](https://github.com/oscharko-dev/c2c-PreBeta/issues/96) | Pipeline progress and Experience Learning telemetry are exposed for UI-started runs. |
| [#98](https://github.com/oscharko-dev/c2c-PreBeta/issues/98) | Model governance is wired into UI-started application runs. |
| [#95](https://github.com/oscharko-dev/c2c-PreBeta/issues/95) and [#130](https://github.com/oscharko-dev/c2c-PreBeta/issues/130) | Browser acceptance and visual-regression coverage for the real product path. |

The later W0.1 Studio parent
[#118](https://github.com/oscharko-dev/c2c-PreBeta/issues/118) expanded the
browser workbench target into a Next.js/Tailwind application. Its implementation
children [#119](https://github.com/oscharko-dev/c2c-PreBeta/issues/119),
[#137](https://github.com/oscharko-dev/c2c-PreBeta/issues/137), and
[#121](https://github.com/oscharko-dev/c2c-PreBeta/issues/121) through
[#130](https://github.com/oscharko-dev/c2c-PreBeta/issues/130) are closed.

## Repository Evidence

| Evidence | Location |
|----------|----------|
| Product launcher | [`scripts/start-c2c-local.sh`](../../scripts/start-c2c-local.sh) |
| Local smoke gate | [`scripts/smoke-test-c2c-local.sh`](../../scripts/smoke-test-c2c-local.sh) |
| Studio browser acceptance | [`apps/c2c-studio/tests/e2e/workflow.spec.ts`](../../apps/c2c-studio/tests/e2e/workflow.spec.ts) |
| Studio progress timeline | [`apps/c2c-studio/src/components/run/BuildTestPanel.tsx`](../../apps/c2c-studio/src/components/run/BuildTestPanel.tsx), [`apps/c2c-studio/src/hooks/useRunPolling.ts`](../../apps/c2c-studio/src/hooks/useRunPolling.ts) |
| Studio Playwright stack wiring | [`apps/c2c-studio/playwright.config.ts`](../../apps/c2c-studio/playwright.config.ts) |
| BFF product API | [`services/c2c-bff/src/server.ts`](../../services/c2c-bff/src/server.ts) |
| BFF no-placeholder and artifact contract tests | [`services/c2c-bff/src/server.test.ts`](../../services/c2c-bff/src/server.test.ts) |
| Orchestrated artifact persistence | [`services/orchestrator-service/src/orchestrator_service/artifacts.py`](../../services/orchestrator-service/src/orchestrator_service/artifacts.py) |
| Release gate | [`docs/release/w0-release-gate.md`](w0-release-gate.md) |

## Re-Evidencing Commands

A reviewer can re-run the #86 closure gate from a clean checkout with:

```bash
./scripts/ci-checks.sh
./scripts/w0-reference-run.sh
./scripts/smoke-test-c2c-local.sh
npm test --prefix apps/c2c-studio
npm test --prefix services/c2c-bff
(cd apps/c2c-studio && CI=1 npm run test:e2e:ci)
```

The long-form language gates remain the same as the W0 release gate:

```bash
./scripts/go-check.sh
./scripts/python-check.sh
./scripts/typescript-check.sh
(cd services/build-test-runner-service && mvn -B -ntp test)
(cd services/target-java-generation-service && mvn -B -ntp test)
```

The browser visual baseline is maintained from the primary macOS Chromium
environment:

```bash
(cd apps/c2c-studio && npm run test:e2e:update-snapshots)
```
