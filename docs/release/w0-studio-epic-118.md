# W0.1 Studio Epic #118 Closure Evidence

Issue [#118](https://github.com/oscharko-dev/c2c-PreBeta/issues/118)
is the Wave 0.1 parent epic for turning the browser experience into the
Next.js/Tailwind c2c Transformation Studio.

This document records the closure evidence for the Studio epic. It complements
the Wave 0 release gate and the corrective product-path evidence for
[#86](https://github.com/oscharko-dev/c2c-PreBeta/issues/86).

## Closure Decision

The Issue #118 Studio epic is satisfied when the current `dev` branch provides:

- a Next.js App Router, React, TypeScript, and Tailwind Studio application;
- a Claude-inspired IDE workbench with top bar, activity rails, source
  workspace, split COBOL/Java editors, target Java inspector, bottom workbench,
  and status bar;
- runtime-configured browser calls to the c2c BFF only, never directly to
  internal services;
- editable or pasted COBOL source that starts a BFF/orchestrator-backed
  `POST /api/v0/transform` run;
- generated Java rendered from persisted run files and byte-bound to the BFF
  `/generated/files/{path}` content for the active run;
- build/test, equivalence, Evidence Pack, progress, Harness events, run
  artifacts, model-governance, and Experience Learning surfaces for that same
  run;
- explicit blocked, unavailable, unsupported, incomplete, failed, and
  verification-blocked states instead of success fallback;
- a deterministic no-model W0 browser path that works with model gateway
  disabled and records model-policy-skipped evidence;
- automated unit, browser, smoke, CI, and release-gate coverage that fails if
  successful output is hard-coded or detached from BFF artifacts.

## Child Issue Audit

The W0.1 implementation children are complete on `dev`:

| Issue | Closure evidence |
|-------|------------------|
| [#119](https://github.com/oscharko-dev/c2c-PreBeta/issues/119) | Initial product frontend and BFF runtime contract. |
| [#137](https://github.com/oscharko-dev/c2c-PreBeta/issues/137) | Corrective replacement of the earlier scaffold with Next.js/Tailwind. |
| [#121](https://github.com/oscharko-dev/c2c-PreBeta/issues/121) | Tailwind design system and Studio visual tokens. |
| [#122](https://github.com/oscharko-dev/c2c-PreBeta/issues/122) | IDE-grade shell layout and responsive workbench. |
| [#123](https://github.com/oscharko-dev/c2c-PreBeta/issues/123) | Source workspace tree and editable COBOL editor. |
| [#124](https://github.com/oscharko-dev/c2c-PreBeta/issues/124) | Typed BFF API client and transformation run store. |
| [#125](https://github.com/oscharko-dev/c2c-PreBeta/issues/125) | Generated Java editor and target artifact inspector. |
| [#126](https://github.com/oscharko-dev/c2c-PreBeta/issues/126) | Build/Test, Evidence Pack, and run artifact panels. |
| [#127](https://github.com/oscharko-dev/c2c-PreBeta/issues/127) | Experience Learning, Harness, and Model Gateway observability. |
| [#128](https://github.com/oscharko-dev/c2c-PreBeta/issues/128) | Product-grade unavailable, unsupported, failure, and incomplete states. |
| [#129](https://github.com/oscharko-dev/c2c-PreBeta/issues/129) | Accessibility, keyboard navigation, resizing, and performance hardening. |
| [#130](https://github.com/oscharko-dev/c2c-PreBeta/issues/130) | Browser acceptance and visual-regression coverage. |

## Repository Evidence

| Evidence | Location |
|----------|----------|
| Studio app shell | [`apps/c2c-studio/src/components/workbench/WorkbenchShell.tsx`](../../apps/c2c-studio/src/components/workbench/WorkbenchShell.tsx) |
| Source workspace and COBOL editor | [`apps/c2c-studio/src/components/source/SourceWorkspaceTree.tsx`](../../apps/c2c-studio/src/components/source/SourceWorkspaceTree.tsx), [`apps/c2c-studio/src/components/source/CobolEditorPane.tsx`](../../apps/c2c-studio/src/components/source/CobolEditorPane.tsx) |
| Typed BFF client and runtime config | [`apps/c2c-studio/src/lib/apiClient.ts`](../../apps/c2c-studio/src/lib/apiClient.ts), [`apps/c2c-studio/src/hooks/useC2cApi.ts`](../../apps/c2c-studio/src/hooks/useC2cApi.ts) |
| Run state and artifact hydration | [`apps/c2c-studio/src/stores/transformationRun.tsx`](../../apps/c2c-studio/src/stores/transformationRun.tsx), [`apps/c2c-studio/src/hooks/useRunPolling.ts`](../../apps/c2c-studio/src/hooks/useRunPolling.ts) |
| Generated Java artifact browser | [`apps/c2c-studio/src/hooks/useGeneratedArtifacts.ts`](../../apps/c2c-studio/src/hooks/useGeneratedArtifacts.ts), [`apps/c2c-studio/src/components/generated/GeneratedJavaEditorPane.tsx`](../../apps/c2c-studio/src/components/generated/GeneratedJavaEditorPane.tsx), [`apps/c2c-studio/src/components/generated/TargetJavaInspector.tsx`](../../apps/c2c-studio/src/components/generated/TargetJavaInspector.tsx) |
| Build, evidence, artifact, progress, and learning panels | [`apps/c2c-studio/src/components/run/`](../../apps/c2c-studio/src/components/run/), [`apps/c2c-studio/src/components/observability/`](../../apps/c2c-studio/src/components/observability/) |
| Product state model | [`apps/c2c-studio/src/types/state.ts`](../../apps/c2c-studio/src/types/state.ts) |
| BFF product API and OpenAPI contract | [`services/c2c-bff/src/server.ts`](../../services/c2c-bff/src/server.ts), [`services/c2c-bff/openapi.yaml`](../../services/c2c-bff/openapi.yaml) |
| Browser acceptance and visual baseline | [`apps/c2c-studio/tests/e2e/workflow.spec.ts`](../../apps/c2c-studio/tests/e2e/workflow.spec.ts), [`apps/c2c-studio/playwright.config.ts`](../../apps/c2c-studio/playwright.config.ts) |
| Accessibility, keyboard, resize, state, and contract tests | [`apps/c2c-studio/tests/`](../../apps/c2c-studio/tests/) |
| Local product launcher and smoke gate | [`scripts/start-c2c-local.sh`](../../scripts/start-c2c-local.sh), [`scripts/smoke-test-c2c-local.sh`](../../scripts/smoke-test-c2c-local.sh) |
| CI browser/unit gates | [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml), [`.github/workflows/platform-baseline.yml`](../../.github/workflows/platform-baseline.yml) |

## Re-Evidencing Commands

A reviewer can re-run the Issue #118 closure gate from a clean checkout with:

```bash
export C2C_LOCAL_ENV_FILE="$PWD/.env"
export C2C_LOCAL_MODEL_GATEWAY_ENABLED=false

C2C_LOCAL_ENV_FILE="$C2C_LOCAL_ENV_FILE" ./scripts/ci-checks.sh
C2C_LOCAL_ENV_FILE="$C2C_LOCAL_ENV_FILE" \
  C2C_LOCAL_MODEL_GATEWAY_ENABLED=false \
  ./scripts/smoke-test-c2c-local.sh
npm test --prefix apps/c2c-studio
npm run build --prefix apps/c2c-studio
(cd apps/c2c-studio && \
  CI=1 \
  C2C_LOCAL_ENV_FILE="$C2C_LOCAL_ENV_FILE" \
  C2C_LOCAL_MODEL_GATEWAY_ENABLED=false \
  npm run test:e2e:ci)
```

The full Wave 0 service-mesh reference run remains:

```bash
W0_REFERENCE_RUN_ENV_FILE="$PWD/.env" \
  W0_REFERENCE_RUN_MODEL_GATEWAY_ENABLED=false \
  ./scripts/w0-reference-run.sh
```

Most recent local re-evidence for this closure: run tag
`20260515T193853Z` on 2026-05-15, with 3/3 generated Java compile/run
successes, 3/3 Golden Master matches, 3/3 complete Evidence Packs, 40 Harness
events, and 10 Experience Events.

The desktop visual baseline is intentionally pinned to the primary local macOS
Chromium environment:

```bash
(cd apps/c2c-studio && npm run test:e2e:update-snapshots)
```

## Scope Boundaries

The #118 closure is a production-grade W0.1 Studio implementation, not a claim
that c2c is ready for customer production workloads. The W0 release-gate
limitations still apply: the COBOL subset is narrow, no customer source has
been ingested, and Wave 1 remains responsible for broader COBOL coverage,
customer deployment hardening, and default model-gateway exercise.
