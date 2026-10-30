const test = require('node:test');
const assert = require('node:assert/strict');
const {
  OUTBOX_ATTEMPTS, isShaConflict, writeFailure, decide, pendingText,
  addItem, removeItem, markHeld, itemKey, nextItem,
} = require('../outbox.js');

const file = { path: '0001-two-sum.py', content: 'class Solution: pass\n', message: '1. Two Sum (Python3)' };
const other = { path: '0001-two-sum.py', content: 'class Solution: return\n', message: '1. Two Sum (Python3)' };

test('a file is cleared only after GitHub confirms it, including the identical-content skip', () => {
  let items = addItem([], file);
  assert.equal(decide({ kind: 'github', status: 'network' }, 1).action, 'retry');
  assert.equal(items.length, 1);
  assert.equal(decide(null, 1).action, 'clear');
  items = removeItem(items, file);
  assert.deepEqual(items, []);
});

test('auth and scope failures are held and are not resumed on the next wake', () => {
  for (const failure of [
    { kind: 'revoked' },
    { kind: 'overScoped', text: 'this token can read o/r.' },
    { kind: 'noTarget' },
    { kind: 'unusable', text: 'you own over 100 repos, more than AC2Git can check.' },
    { kind: 'noToken' },
    writeFailure(401),
    writeFailure(403),
    writeFailure(404),
  ]) {
    assert.equal(decide(failure, 1).action, 'hold', failure.kind);
    assert.notEqual(decide(failure, OUTBOX_ATTEMPTS).action, 'retry', failure.kind);
  }
  assert.equal(decide(writeFailure(401), 1).revoked, true);
  assert.equal(decide(writeFailure(403), 1).revoked, false);

  const held = markHeld(addItem([], file), file, true);
  assert.equal(nextItem(held, { includeHeld: false, paused: new Set() }), null);
  assert.equal(nextItem(held, { includeHeld: true, paused: new Set() }).content, file.content);
});

test('transient failures retry a bounded number of times, then wait for the next wake', () => {
  for (const failure of [
    { kind: 'github', status: 'network' },
    writeFailure(409),
    writeFailure(422),
    writeFailure(429),
    writeFailure(500),
  ]) {
    assert.equal(decide(failure, 1).action, 'retry', String(failure.status));
    assert.equal(decide(failure, OUTBOX_ATTEMPTS - 1).action, 'retry', String(failure.status));
    assert.equal(decide(failure, OUTBOX_ATTEMPTS).action, 'later', String(failure.status));
  }
  const items = addItem([], file);
  const paused = new Set([itemKey(file)]);
  assert.equal(nextItem(items, { paused }), null);
  assert.equal(nextItem(items, { paused: new Set() }).path, file.path);
  assert.match(pendingText({ kind: 'github', status: 'network' }), /^Pending, will retry: couldn't reach GitHub\./);
  assert.match(pendingText(writeFailure(503)), /^Pending, will retry: GitHub error 503\./);
  assert.equal(pendingText(null), 'Pending, will retry.');
});

test('409 and 422 are sha conflicts; auth and scope statuses are not', () => {
  assert.equal(isShaConflict(409), true);
  assert.equal(isShaConflict(422), true);
  assert.equal(isShaConflict(401), false);
  assert.equal(isShaConflict(403), false);
  assert.equal(isShaConflict(200), false);
  assert.equal(isShaConflict(undefined), false);
});

test('the outbox stores two different files and never a token', () => {
  const first = addItem([], { ...file, token: 'github_pat_secret', held: true });
  assert.deepEqual(first, [{ path: file.path, content: file.content, message: file.message, held: false }]);
  const both = addItem(first, other);
  assert.equal(both.length, 2);
  assert.equal(addItem(both, file), both);
  assert.equal(removeItem(both, file).length, 1);
  assert.equal(removeItem(both, file)[0].content, other.content);
  assert.equal(removeItem(both, { path: 'missing.py', content: 'nope' }), both);
});
