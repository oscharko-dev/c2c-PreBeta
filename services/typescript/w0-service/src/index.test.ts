import test from 'node:test';
import assert from 'node:assert/strict';
import { runPayroll, runStatus } from './index';

test('runPayroll keeps decimals stable', () => {
  assert.equal(runPayroll(125.75, 8, 0.1887), 816.17);
});

test('runStatus for ok path', () => {
  assert.equal(runStatus(true), 'OK');
  assert.equal(runStatus(false), 'ALERT');
});
