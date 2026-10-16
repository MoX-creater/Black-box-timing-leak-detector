import test from 'node:test';
import assert from 'node:assert/strict';

test('Node test runner is configured', () => {
  assert.match(process.version, /^v\d+\.\d+\.\d+$/);
});
