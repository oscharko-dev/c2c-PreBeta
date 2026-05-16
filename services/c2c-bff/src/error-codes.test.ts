import test from 'node:test';
import assert from 'node:assert/strict';

import {
  W02_UI_ERROR_CODES,
  defaultMessageFor,
  mapFailure,
  mapOrchestratorFailureCode,
  mapUpstreamUnavailable,
  sanitizeUpstreamMessage,
} from './error-codes';

const ORCHESTRATOR_FAILURE_CODES = [
  'unsupported_cobol',
  'parse_failed',
  'semantic_ir_failed',
  'model_gateway_unavailable',
  'model_policy_denied',
  'agent_timeout',
  'agent_contract_invalid',
  'java_generation_failed',
  'java_compile_failed',
  'java_runtime_failed',
  'oracle_mismatch',
  'evidence_incomplete',
  'cancelled',
];

test('every orchestrator failure code maps to a UI-safe code with a default message', () => {
  for (const code of ORCHESTRATOR_FAILURE_CODES) {
    const mapped = mapOrchestratorFailureCode(code);
    assert.ok(mapped, `expected orchestrator code ${code} to map`);
    assert.ok(W02_UI_ERROR_CODES.includes(mapped!), `mapped code ${mapped} is in the UI-safe enum`);
    const message = defaultMessageFor(mapped!);
    assert.ok(message.length > 0, `expected non-empty default message for ${mapped}`);
  }
});

test('unknown orchestrator failure codes collapse to internal_error', () => {
  assert.equal(mapOrchestratorFailureCode('totally_new_failure'), 'internal_error');
  assert.equal(mapOrchestratorFailureCode(42 as unknown as string), null);
  assert.equal(mapOrchestratorFailureCode(''), null);
});

test('sanitizeUpstreamMessage strips secrets, URLs, file paths, and stack traces', () => {
  const raw = 'Failure at http://orchestrator.internal:18088/v0/runs/abc with key sk-1234567890abcdefABCDEF and Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signaturefoo at module.fn (/Users/me/repo/file.ts:10:5)';
  const sanitized = sanitizeUpstreamMessage(raw, 'fallback');
  assert.ok(!sanitized.includes('http://'), `expected URL to be redacted: ${sanitized}`);
  assert.ok(!sanitized.includes('sk-1234'), `expected api key to be redacted: ${sanitized}`);
  assert.ok(!sanitized.includes('Bearer'), `expected bearer to be redacted: ${sanitized}`);
  assert.ok(!sanitized.includes('/Users/'), `expected absolute path to be redacted: ${sanitized}`);
  assert.ok(!sanitized.includes('at module.fn'), `expected stack frame to be removed: ${sanitized}`);
});

test('sanitizeUpstreamMessage falls back when input is empty or non-string', () => {
  assert.equal(sanitizeUpstreamMessage('', 'default'), 'default');
  assert.equal(sanitizeUpstreamMessage(undefined, 'default'), 'default');
  assert.equal(sanitizeUpstreamMessage(42, 'default'), 'default');
});

test('sanitizeUpstreamMessage clamps very long messages so the UI can render inline', () => {
  const big = 'a'.repeat(2_000);
  const sanitized = sanitizeUpstreamMessage(big, 'fallback');
  assert.ok(sanitized.length <= 280, `expected sanitized length <= 280, got ${sanitized.length}`);
});

test('mapFailure returns null when no code is known and no fallback is supplied', () => {
  assert.equal(mapFailure(undefined, undefined), null);
  assert.equal(mapFailure('', null), null);
});

test('mapFailure pairs a UI-safe code with a sanitized message', () => {
  const failure = mapFailure('java_compile_failed', 'compile at http://orch.internal/v0/runs/x failed');
  assert.equal(failure?.code, 'java_compile_failed');
  assert.ok(failure && !failure.message.includes('http://'));
});

test('mapUpstreamUnavailable always returns service_unavailable with a default message', () => {
  const failure = mapUpstreamUnavailable();
  assert.equal(failure.code, 'service_unavailable');
  assert.ok(failure.message.length > 0);
  const withDetail = mapUpstreamUnavailable('connect ECONNREFUSED 127.0.0.1:18088');
  assert.equal(withDetail.code, 'service_unavailable');
});
