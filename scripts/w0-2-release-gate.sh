#!/usr/bin/env bash
# W0.2 release gate (Issue #175).
#
# End-to-end verification that the W0.2 agentic COBOL → Java path is
# production-ready on this branch. The gate starts the local product stack,
# submits the W0.2 acceptance fixture(s), waits for the agentic workflow to
# complete, and asserts every contract item from
# docs/release/w0-2-release-gate.md:
#
#   1. Studio, BFF, Orchestrator, Model Gateway, Harness, Evidence are healthy.
#   2. The BFF is the only browser-visible backend boundary.
#   3. The Orchestrator drives the W0.2 workflow contract; the Harness records.
#   4. POST /api/v0/transform with the W0.2 acceptance source reaches
#      finalClassification=success with a populated repairBudget. In
#      deterministic mode the gate submits BRNCH01 (the W0/W0.1
#      deterministic acceptance program) because the productive agentic
#      loop is unavailable without the Model Gateway; the W0.2 workflow
#      contract envelope is still exposed and asserted. In --foundry
#      mode the gate submits HELLOW02 (the W0.2 agentic acceptance
#      fixture) so the productive Transformation/Verification path is
#      exercised end-to-end.
#   5. Generated Java exists on the artifact store with a sha256 the BFF
#      can echo back through GeneratedView, BuildTestView, EvidenceView.
#   6. Build/test classification == match with the COBOL oracle.
#   7. In --foundry mode the Evidence Pack manifest passes
#      scripts/check_w0_2_evidence.py --success --expect-foundry-invocation,
#      i.e. carries modelInvocations status=completed, agentTrajectories,
#      generatedJavaArtifacts, finalJavaArtifact, and oracleComparison.
#      In deterministic mode the manifest hash is asserted resolvable
#      through safe artifact metadata and pointer-consistent; the productive
#      W0.2 slots are not enforced because they require the agentic path.
#   8. POST /api/v0/transform with the FILEIO-UNSUPPORTED fixture reaches
#      finalClassification=blocked with failureCode=unsupported_cobol and
#      produces no Java.
#   9. The Studio root document loads and renders the workbench shell so
#      the UI-to-agent-to-Java-to-evidence path is verifiable in a browser.
#  10. Evidence artifacts on disk contain no provider credentials or bearer
#      tokens (assertion delegated to scripts/check_w0_2_evidence.py).
#
# Usage:
#   scripts/w0-2-release-gate.sh [--foundry]
#
# --foundry  Enable the Model Gateway and require Foundry credentials.
#            Refuses to start without AZURE_FOUNDRY_API_KEY (or
#            AZURE_FOUNDRY_API_KEY_REF) and AZURE_FOUNDRY_ENDPOINT.
#            This mode runs an actual provider invocation; do not enable
#            in public CI.
#
# Exit codes:
#   0  every gate assertion passed.
#   1  pre-flight failed (missing tools, secrets, ports, scripts).
#   2  the local product stack failed to come up.
#   3  the HELLOW02 success path failed an assertion.
#   4  the FILEIO-UNSUPPORTED blocked path failed an assertion.
#   5  the Evidence Pack manifest failed the W0.2 completeness contract.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

MODE="deterministic"
for arg in "$@"; do
  case "$arg" in
    --foundry)
      MODE="foundry"
      ;;
    --help|-h)
      sed -n '2,52p' "$0"
      exit 0
      ;;
    *)
      printf '[w0.2-gate][error] unknown argument: %s\n' "$arg" >&2
      exit 1
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Pre-flight
# ---------------------------------------------------------------------------

for tool in curl jq python3; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    printf '[w0.2-gate][error] missing tool: %s\n' "$tool" >&2
    exit 1
  fi
done

ENV_FILE="${C2C_LOCAL_ENV_FILE:-$ROOT_DIR/.env}"
NORMALIZED_ENV_FILE=""

# The launcher has a latent quirk: if C2C_LOCAL_VAR_DIR (or its derived
# READY_MARKER / RUN_ARTIFACT_ROOT) is a relative path, the Go binary
# build cd's into the service directory while keeping the -o path
# relative, so the harness binary ends up inside the service tree
# instead of $ROOT_DIR/var/c2c-local/bin/. To stay robust to both the
# convenient relative paths in .env.example and the absolute defaults
# the launcher uses when no env file is present, we materialise a
# normalised copy of the env file with all c2c-local paths rewritten
# to absolute, and point the launcher at the copy.
if [[ -f "$ENV_FILE" ]]; then
  NORMALIZED_ENV_FILE="$(mktemp "${TMPDIR:-/tmp}/c2c-w0.2-env.XXXXXX")"
  # The cleanup trap further down deletes this file on exit.
  python3 - "$ENV_FILE" "$ROOT_DIR" "$NORMALIZED_ENV_FILE" <<'PY'
import os, sys
src, root, dst = sys.argv[1], sys.argv[2], sys.argv[3]
relative_keys = {"C2C_LOCAL_VAR_DIR", "C2C_LOCAL_READY_MARKER", "C2C_RUN_ARTIFACT_ROOT"}
with open(src, "r", encoding="utf-8") as fh, open(dst, "w", encoding="utf-8") as out:
    for line in fh:
        stripped = line.lstrip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            out.write(line); continue
        key, _, value = stripped.partition("=")
        key = key.strip()
        value = value.rstrip("\n").strip().strip("'\"")
        if key in relative_keys and value and not os.path.isabs(value):
            out.write(f"{key}={os.path.join(root, value)}\n")
        else:
            out.write(line)
PY
  set -a
  # shellcheck disable=SC1090
  source "$NORMALIZED_ENV_FILE"
  set +a
  export C2C_LOCAL_ENV_FILE="$NORMALIZED_ENV_FILE"
else
  export C2C_LOCAL_ENV_FILE="$ENV_FILE"
fi

if [[ "$MODE" == "foundry" ]]; then
  if [[ -z "${AZURE_FOUNDRY_API_KEY:-}" && -z "${AZURE_FOUNDRY_API_KEY_REF:-}" ]]; then
    printf '[w0.2-gate][error] --foundry requires AZURE_FOUNDRY_API_KEY or AZURE_FOUNDRY_API_KEY_REF\n' >&2
    exit 1
  fi
  if [[ -z "${AZURE_FOUNDRY_ENDPOINT:-}" ]]; then
    printf '[w0.2-gate][error] --foundry requires AZURE_FOUNDRY_ENDPOINT\n' >&2
    exit 1
  fi
  export C2C_LOCAL_MODEL_GATEWAY_ENABLED=true
else
  export C2C_LOCAL_MODEL_GATEWAY_ENABLED=false
fi

VAR_DIR="${C2C_LOCAL_VAR_DIR:-$ROOT_DIR/var/c2c-local}"
READY_MARKER="${C2C_LOCAL_READY_MARKER:-$VAR_DIR/ready}"
BFF_PORT="${C2C_LOCAL_BFF_PORT:-18089}"
BFF_URL="http://127.0.0.1:${BFF_PORT}"
STUDIO_PORT="${C2C_LOCAL_STUDIO_PORT:-3000}"
STUDIO_URL="http://127.0.0.1:${STUDIO_PORT}"
RUN_ARTIFACT_ROOT="${C2C_RUN_ARTIFACT_ROOT:-$VAR_DIR/runs}"

# In deterministic mode the agentic loop is unavailable (Model Gateway off),
# so the gate runs the W0/W0.1 deterministic acceptance program (BRNCH01,
# branch-account-guard.cbl) for the success-path assertions. It still proves
# that the W0.2 workflow contract surface, repair budget, and Evidence Pack
# slots are populated for every accepted run — what it does NOT prove in this
# mode is the productive agent path. That stays behind --foundry, which uses
# the W0.2 acceptance fixture (HELLOW02, hello-w02.cbl).
if [[ "$MODE" == "foundry" ]]; then
  POSITIVE_SOURCE="$ROOT_DIR/corpus/synthetic/programs/hello-w02.cbl"
  POSITIVE_EXPECTED="$ROOT_DIR/corpus/synthetic/fixtures/hello-w02-output.txt"
  POSITIVE_FIXTURE_LABEL="HELLOW02 (W0.2 agentic acceptance fixture)"
  POSITIVE_SOURCE_NAME="hello-w02.cbl"
else
  POSITIVE_SOURCE="$ROOT_DIR/corpus/synthetic/programs/branch-account-guard.cbl"
  POSITIVE_EXPECTED=""
  POSITIVE_FIXTURE_LABEL="BRNCH01 (W0/W0.1 deterministic acceptance program)"
  POSITIVE_SOURCE_NAME="branch-account-guard.cbl"
fi
NEGATIVE_SOURCE="$ROOT_DIR/corpus/synthetic/programs/file-io-unsupported.cbl"
required_paths=("$POSITIVE_SOURCE" "$NEGATIVE_SOURCE")
if [[ -n "$POSITIVE_EXPECTED" ]]; then
  required_paths+=("$POSITIVE_EXPECTED")
fi
for path in "${required_paths[@]}"; do
  [[ -f "$path" ]] || { printf '[w0.2-gate][error] required fixture missing: %s\n' "$path" >&2; exit 1; }
done

log()  { printf '[w0.2-gate] %s\n' "$*" >&2; }
fail() { printf '[w0.2-gate][error] %s\n' "$*" >&2; exit "${2:-3}"; }

curl_json() {
  local url="$1"
  curl -fsS --max-time 20 "$url"
}

post_json() {
  local url="$1"
  local payload="$2"
  curl -fsS --max-time 30 \
    -H 'Content-Type: application/json' \
    -X POST \
    --data "$payload" \
    "$url"
}

artifact_path_for_hash() {
  local artifacts_json="$1"
  local sha="$2"
  local kind="$3"
  jq -r --arg sha "$sha" --arg kind "$kind" '
    .artifacts[]?
    | select(.kind == $kind and .sha256 == $sha)
    | .path // empty
  ' <<<"$artifacts_json" | head -n 1
}

artifact_store_run_id() {
  local bff_run_id="$1"
  local view_json="$2"
  local upstream_run_id
  upstream_run_id="$(jq -r '.orchestratorRunId // empty' <<<"$view_json")"
  if [[ -n "$upstream_run_id" ]]; then
    printf '%s' "$upstream_run_id"
    return
  fi
  printf '%s' "$bff_run_id"
}

artifact_file_path_for_run() {
  local run_id="$1"
  local relpath="$2"
  [[ -n "$run_id" && -n "$relpath" ]] || { printf ''; return; }
  [[ "$relpath" != /* && "$relpath" != *'\'* ]] || { printf ''; return; }

  local segment
  local -a segments
  IFS='/' read -r -a segments <<<"$relpath"
  for segment in "${segments[@]}"; do
    if [[ -z "$segment" || "$segment" == "." || "$segment" == ".." ]]; then
      printf ''
      return
    fi
  done

  printf '%s/%s/%s' "$RUN_ARTIFACT_ROOT" "$run_id" "$relpath"
}

# ---------------------------------------------------------------------------
# Stack lifecycle
# ---------------------------------------------------------------------------

launcher_log="$(mktemp "${TMPDIR:-/tmp}/c2c-w0.2-gate-launcher.XXXXXX.log")"
launcher_pid=""

cleanup() {
  local exit_code=$?
  "$ROOT_DIR/scripts/stop-c2c-local.sh" >/dev/null 2>&1 || true
  if [[ -n "$launcher_pid" ]]; then
    wait "$launcher_pid" 2>/dev/null || true
  fi
  if (( exit_code != 0 )); then
    log "launcher log tail (failure):"
    tail -n 120 "$launcher_log" >&2 || true
  fi
  rm -f "$launcher_log"
  if [[ -n "$NORMALIZED_ENV_FILE" && -f "$NORMALIZED_ENV_FILE" ]]; then
    rm -f "$NORMALIZED_ENV_FILE"
  fi
  exit "$exit_code"
}
trap cleanup EXIT INT TERM

log "starting local product stack (mode=$MODE, model_gateway=${C2C_LOCAL_MODEL_GATEWAY_ENABLED})"
rm -f "$READY_MARKER"
"$ROOT_DIR/scripts/start-c2c-local.sh" --ci >"$launcher_log" 2>&1 &
launcher_pid=$!

# Wait for the launcher to publish the ready marker pointing at the Studio.
wait_seconds=1800
while (( wait_seconds > 0 )); do
  if [[ -f "$READY_MARKER" ]]; then
    break
  fi
  if ! kill -0 "$launcher_pid" 2>/dev/null; then
    fail "launcher exited before publishing $READY_MARKER" 2
  fi
  sleep 1
  wait_seconds=$((wait_seconds - 1))
done
[[ -f "$READY_MARKER" ]] || fail "ready marker did not appear: $READY_MARKER" 2

ready_target="$(tr -d '\r\n' <"$READY_MARKER")"
[[ "$ready_target" == "$STUDIO_URL" ]] || fail "ready marker pointed at $ready_target, expected $STUDIO_URL" 2

# ---------------------------------------------------------------------------
# Surface-level service health
# ---------------------------------------------------------------------------

log "asserting BFF / Studio / Harness / Model Gateway surfaces"

curl_json "$BFF_URL/api/v0/health" >/dev/null || fail "BFF health endpoint did not respond" 2
curl_json "$STUDIO_URL" >/dev/null || fail "Studio root did not respond" 2

studio_html="$(curl -fsS --max-time 5 "$STUDIO_URL")"
grep -Fq 'c2c Transformation Studio' <<<"$studio_html" \
  || fail "Studio root did not render the workbench shell" 2

mode_json="$(curl_json "$BFF_URL/api/v0/mode")"
jq -e '.orchestrator == "live" and .evidence == "live"' >/dev/null <<<"$mode_json" \
  || fail "BFF mode endpoint did not report live orchestrator + evidence: $mode_json" 2

# /api/v0/harness/ready and /api/v0/model-gateway/health are required to
# return 200 (the launcher waits for them). The gate re-asserts the
# transport so a stack regression that only the BFF observes is caught.
curl_json "$BFF_URL/api/v0/harness/ready" >/dev/null \
  || fail "Harness readiness endpoint did not respond" 2

if [[ "$C2C_LOCAL_MODEL_GATEWAY_ENABLED" == "true" ]]; then
  curl_json "$BFF_URL/api/v0/model-gateway/health" >/dev/null \
    || fail "Model Gateway health endpoint did not respond (--foundry mode)" 2
fi

# ---------------------------------------------------------------------------
# Phase 1 — HELLOW02 success path
# ---------------------------------------------------------------------------

log "submitting $POSITIVE_FIXTURE_LABEL to BFF /transform"
if [[ -n "$POSITIVE_EXPECTED" ]]; then
  transform_payload="$(jq -n \
    --rawfile source "$POSITIVE_SOURCE" \
    --rawfile expected "$POSITIVE_EXPECTED" \
    --arg name "$POSITIVE_SOURCE_NAME" \
    '{sourceText: $source, sourceName: $name, expectedOutput: $expected}')"
else
  transform_payload="$(jq -n \
    --rawfile source "$POSITIVE_SOURCE" \
    --arg name "$POSITIVE_SOURCE_NAME" \
    '{sourceText: $source, sourceName: $name}')"
fi
transform_json="$(post_json "$BFF_URL/api/v0/transform" "$transform_payload")"
positive_run_id="$(jq -r '.runId // empty' <<<"$transform_json")"
[[ -n "$positive_run_id" ]] || fail "transform response missing runId for $POSITIVE_FIXTURE_LABEL: $transform_json" 3

log "polling run $positive_run_id to completion"
positive_summary=""
positive_workflow=""
for _ in $(seq 1 300); do
  positive_summary="$(curl_json "$BFF_URL/api/v0/runs/$positive_run_id")"
  positive_workflow="$(curl_json "$BFF_URL/api/v0/runs/$positive_run_id/workflow")"
  status="$(jq -r '.status // empty' <<<"$positive_summary")"
  classification="$(jq -r '.finalClassification // empty' <<<"$positive_workflow")"
  if [[ "$classification" == "success" ]]; then
    break
  fi
  if [[ "$status" == "failed" || "$classification" == "blocked" || "$classification" == "failed" || "$classification" == "incomplete" ]]; then
    fail "$POSITIVE_FIXTURE_LABEL run did not succeed: status=$status finalClassification=$classification workflow=$positive_workflow" 3
  fi
  sleep 1
done

jq -e --arg run "$positive_run_id" '
  .runId == $run
  and .finalClassification == "success"
  and .failureCode == null
  and .state == "final_classification"
  and (.activeAgent == null)
  and (.repairBudget != null)
  and (.repairBudget.limit | type == "number")
  and (.repairBudget.used | type == "number")
  and (.repairBudget.remaining | type == "number")
  and (.repairBudget.used + .repairBudget.remaining == .repairBudget.limit)
  and (.generatedJavaRef != null)
  and (.buildTestResultRef != null)
  and (.evidencePackRef != null)
' >/dev/null <<<"$positive_workflow" \
  || fail "$POSITIVE_FIXTURE_LABEL workflow contract failed shape assertion: $positive_workflow" 3

# Generated, build/test, evidence views must round-trip the same sha256.
generated_json="$(curl_json "$BFF_URL/api/v0/runs/$positive_run_id/generated")"
build_test_json="$(curl_json "$BFF_URL/api/v0/runs/$positive_run_id/build-test")"
evidence_json="$(curl_json "$BFF_URL/api/v0/runs/$positive_run_id/evidence")"
progress_json="$(curl_json "$BFF_URL/api/v0/runs/$positive_run_id/progress")"
artifacts_json="$(curl_json "$BFF_URL/api/v0/runs/$positive_run_id/artifacts")"

jq -e '.status == "generated" and (.artifactRef.sha256 | length) == 64' >/dev/null <<<"$generated_json" \
  || fail "$POSITIVE_FIXTURE_LABEL GeneratedView is not artifact-backed: $generated_json" 3
jq -e '.status == "ok" and .classification == "match"' >/dev/null <<<"$build_test_json" \
  || fail "$POSITIVE_FIXTURE_LABEL build/test is not a matching success: $build_test_json" 3
jq -e '.status == "complete"' >/dev/null <<<"$evidence_json" \
  || fail "$POSITIVE_FIXTURE_LABEL evidence is not complete: $evidence_json" 3

generated_sha="$(jq -r '.artifactRef.sha256' <<<"$generated_json")"
jq -e --arg sha "$generated_sha" '.generatedArtifactRef.sha256 == $sha' >/dev/null <<<"$build_test_json" \
  || fail "BuildTestView.generatedArtifactRef.sha256 != GeneratedView.artifactRef.sha256" 3
jq -e --arg sha "$generated_sha" '.generatedArtifactRef.sha256 == $sha' >/dev/null <<<"$evidence_json" \
  || fail "EvidenceView.generatedArtifactRef.sha256 != GeneratedView.artifactRef.sha256" 3

# Progress timeline must include the W0.2 step names. The transformation /
# verification agent step names are stable across the workflow contract.
jq -e '
  (.steps | length) > 0
  and ([.steps[].name] | index("accepted"))
  and ([.steps[].name] | index("parse-cobol"))
  and ([.steps[].name] | index("generate-ir"))
  and ([.steps[].name] | index("generate-java"))
  and ([.steps[].name] | index("compile-test-java"))
  and ([.steps[].name] | index("write-evidence"))
  and ([.steps[].name] | index("completed"))
' >/dev/null <<<"$progress_json" \
  || fail "$POSITIVE_FIXTURE_LABEL progress timeline missing required W0.2 step names: $progress_json" 3

if [[ "$C2C_LOCAL_MODEL_GATEWAY_ENABLED" == "true" ]]; then
  jq -e '[.steps[].name] | index("transformation-agent")' >/dev/null <<<"$progress_json" \
    || fail "Foundry-mode progress did not include transformation-agent step: $progress_json" 3
else
  jq -e '[.steps[].name] | index("model-policy-skipped")' >/dev/null <<<"$progress_json" \
    || fail "Deterministic mode progress did not record model-policy-skipped: $progress_json" 3
fi

# The runs/{runId}/artifacts listing must include both the generated project
# manifest and the evidence-pack-manifest by kind.
jq -e '[.artifacts[].kind] | index("evidence-pack-manifest")' >/dev/null <<<"$artifacts_json" \
  || fail "$POSITIVE_FIXTURE_LABEL run artifacts missing evidence-pack-manifest kind: $artifacts_json" 3

# Resolve the Evidence Pack manifest through the browser-safe BFF contract.
# The BFF intentionally does not expose internal file:// URLs or absolute
# artifact paths, so the gate pairs EvidenceView.manifestHash with the
# /artifacts metadata path and reconstructs the local test path itself.
manifest_hash="$(jq -r '.manifestHash // empty' <<<"$evidence_json")"
[[ "$manifest_hash" =~ ^[0-9a-f]{64}$ ]] \
  || fail "EvidenceView did not include a valid manifestHash: $evidence_json" 5
jq -e --arg sha "$manifest_hash" '.artifactRef.sha256 == $sha' >/dev/null <<<"$evidence_json" \
  || fail "EvidenceView.artifactRef.sha256 != EvidenceView.manifestHash" 5
manifest_relpath="$(artifact_path_for_hash "$artifacts_json" "$manifest_hash" "evidence-pack-manifest")"
[[ -n "$manifest_relpath" ]] \
  || fail "run artifacts missing evidence-pack-manifest path for manifestHash $manifest_hash: $artifacts_json" 5
manifest_store_run_id="$(artifact_store_run_id "$positive_run_id" "$artifacts_json")"
manifest_path="$(artifact_file_path_for_run "$manifest_store_run_id" "$manifest_relpath")"
[[ -n "$manifest_path" && -f "$manifest_path" ]] \
  || fail "evidence-pack-manifest artifact path did not resolve locally: $manifest_relpath" 5

if [[ "$MODE" == "foundry" ]]; then
  log "running W0.2 evidence completeness check on $manifest_path"
  python3 "$ROOT_DIR/scripts/check_w0_2_evidence.py" \
    --manifest "$manifest_path" --success --expect-foundry-invocation \
    --root "$RUN_ARTIFACT_ROOT/$positive_run_id" \
    || fail "Evidence Pack manifest did not satisfy the W0.2 success contract" 5
else
  log "deterministic mode: skipping strict W0.2 manifest validator on $manifest_path"
  log "  (productive W0.2 slots require the agentic loop; covered by --foundry)"
fi

# ---------------------------------------------------------------------------
# Phase 2 — FILEIO-UNSUPPORTED blocked path
# ---------------------------------------------------------------------------

log "submitting FILEIO-UNSUPPORTED negative fixture to BFF /transform"
negative_payload="$(jq -n \
  --rawfile source "$NEGATIVE_SOURCE" \
  '{sourceText: $source, sourceName: "file-io-unsupported.cbl"}')"
negative_json="$(post_json "$BFF_URL/api/v0/transform" "$negative_payload")"
negative_run_id="$(jq -r '.runId // empty' <<<"$negative_json")"
[[ -n "$negative_run_id" ]] || fail "transform response missing runId for FILEIO-UNSUPPORTED: $negative_json" 4

log "polling negative run $negative_run_id to terminal classification"
negative_workflow=""
for _ in $(seq 1 180); do
  negative_workflow="$(curl_json "$BFF_URL/api/v0/runs/$negative_run_id/workflow")"
  classification="$(jq -r '.finalClassification // empty' <<<"$negative_workflow")"
  if [[ -n "$classification" && "$classification" != "null" ]]; then
    break
  fi
  sleep 1
done

# The orchestrator must preserve parser-rejected unsupported constructs as
# unsupported COBOL, not collapse them to a generic parse failure.
jq -e --arg run "$negative_run_id" '
  .runId == $run
  and .finalClassification == "blocked"
  and .failureCode == "unsupported_cobol"
  and (.generatedJavaRef == null)
  and (.state == "final_classification")
' >/dev/null <<<"$negative_workflow" \
  || fail "FILEIO-UNSUPPORTED workflow did not reach blocked/unsupported_cobol without generated Java: $negative_workflow" 4

# Generated view must NOT report a successful generation. Either
# `unsupported` (parser emitted diagnostics) or `incomplete` (parser
# bailed early) are honest non-success surfaces; the gate refuses
# `generated`.
negative_generated="$(curl_json "$BFF_URL/api/v0/runs/$negative_run_id/generated")"
jq -e '.status != "generated"' >/dev/null <<<"$negative_generated" \
  || fail "FILEIO-UNSUPPORTED GeneratedView reported a generated status for unsupported source: $negative_generated" 4

# Evidence view (blocked path) must still be reachable; manifest must report
# the blocked completenessStatus and carry no finalJavaArtifact.
negative_evidence="$(curl_json "$BFF_URL/api/v0/runs/$negative_run_id/evidence")"
neg_manifest_hash="$(jq -r '.manifestHash // empty' <<<"$negative_evidence")"
if [[ -n "$neg_manifest_hash" ]]; then
  [[ "$neg_manifest_hash" =~ ^[0-9a-f]{64}$ ]] \
    || fail "blocked EvidenceView included an invalid manifestHash: $negative_evidence" 5
  negative_artifacts="$(curl_json "$BFF_URL/api/v0/runs/$negative_run_id/artifacts")"
  neg_manifest_relpath="$(artifact_path_for_hash "$negative_artifacts" "$neg_manifest_hash" "evidence-pack-manifest")"
  neg_manifest_store_run_id="$(artifact_store_run_id "$negative_run_id" "$negative_artifacts")"
  neg_manifest_path="$(artifact_file_path_for_run "$neg_manifest_store_run_id" "$neg_manifest_relpath")"
  if [[ -n "$neg_manifest_path" && -f "$neg_manifest_path" ]]; then
    log "running W0.2 blocked-path evidence check on $neg_manifest_path"
    python3 "$ROOT_DIR/scripts/check_w0_2_evidence.py" \
      --manifest "$neg_manifest_path" --blocked \
      --root "$RUN_ARTIFACT_ROOT/$negative_run_id" \
      || fail "Blocked-path Evidence Pack manifest failed the W0.2 contract" 5
  fi
fi

# ---------------------------------------------------------------------------
# Optional — Foundry capability smoke (re-uses the existing script).
# ---------------------------------------------------------------------------

if [[ "$MODE" == "foundry" ]]; then
  log "running foundry-smoke.sh capability probe through Model Gateway"
  MODEL_GATEWAY_BASE_URL="http://127.0.0.1:${C2C_LOCAL_MODEL_GATEWAY_PORT:-18087}" \
    "$ROOT_DIR/scripts/foundry-smoke.sh" transformation \
      "${C2C_MODEL_DEFAULT_DEPLOYMENT:-gpt-oss-120b}" \
    || fail "foundry-smoke.sh refused to confirm Foundry capability for transformation" 3
fi

log "W0.2 release gate PASSED (mode=$MODE)"
log "  positive run: $positive_run_id"
log "  negative run: $negative_run_id"
log "  manifest:     $manifest_path"
exit 0
