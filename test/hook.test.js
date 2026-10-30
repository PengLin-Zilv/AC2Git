// hook.js in a vm page world: it must announce a final Accepted verdict and never change the page's fetch.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'hook.js'), 'utf8');
const ORIGIN = 'https://leetcode.com';
const AC = { state: 'SUCCESS', status_code: 10 };
const CHECK = '/submissions/detail/2156492751/v2/check/';
const drain = () => new Promise(setImmediate); // runs every pending promise reaction; no fixed sleep

// A response whose body is already parsed, so hook.js's whole chain settles within one drain().
function fakeResponse(body) {
  const res = { clones: 0, clone: () => (res.clones++, { json: () => (typeof body === 'string' ? Promise.reject(new SyntaxError(body)) : Promise.resolve(body)) }) };
  return res;
}

function page(realFetch) {
  const posted = [];
  let announced;
  const next = new Promise((r) => { announced = r; });
  const window = { fetch: realFetch, postMessage: (m, origin) => { posted.push([structuredClone(m), origin]); announced(); } };
  vm.runInContext(SRC, vm.createContext({ window, location: { origin: ORIGIN, href: `${ORIGIN}/problems/two-sum/` }, URL, Request }));
  return { fetch: window.fetch, posted, next };
}

test('a final Accepted check is announced once, to the same origin only', async () => {
  const p = page(() => Promise.resolve(fakeResponse(AC)));
  p.fetch(CHECK);
  p.fetch(CHECK);
  await p.next;
  await drain();
  assert.deepEqual(p.posted, [[{ source: 'ac2git', type: 'accepted', submissionId: '2156492751' }, ORIGIN]]);
});

test('the page gets the real promise, can still read the body, and its args and this pass through', async () => {
  let seen;
  let original;
  const p = page(function (...args) { seen = [this, args]; original = Promise.resolve(new Response(JSON.stringify(AC))); return original; });
  const self = {};
  const init = { method: 'GET' };
  const returned = p.fetch.call(self, CHECK, init);
  assert.equal(returned, original);
  assert.deepEqual(seen, [self, [CHECK, init]]);
  assert.deepEqual(await (await returned).json(), AC);
  await p.next; // hook.js read its clone too
});

test('rejections and synchronous throws reach the page unchanged', async () => {
  const err = new TypeError('Failed to fetch');
  await assert.rejects(page(() => Promise.reject(err)).fetch(CHECK), (e) => e === err);
  const sync = new TypeError('Illegal invocation');
  assert.throws(() => page(() => { throw sync; }).fetch(CHECK), (e) => e === sync);
  const hostile = { toString() { throw new Error('boom'); } };
  assert.equal(page(() => 'REAL').fetch(hostile), 'REAL');
  await drain();
});

for (const [name, url] of [
  ['Run (runcode_ id on the legacy route)', '/submissions/detail/runcode_1790600217.55_FfJz/check/'],
  ['the legacy /check/ route', '/submissions/detail/5/check/'],
  ['another origin', 'https://evil.example/submissions/detail/5/v2/check/'],
]) {
  test(`${name}: not even read`, async () => {
    const res = fakeResponse(AC);
    const p = page(() => Promise.resolve(res));
    await p.fetch(url);
    await drain();
    assert.equal(res.clones, 0);
    assert.deepEqual(p.posted, []);
  });
}

for (const [name, body] of [
  ['still judging', { state: 'PENDING' }],
  ['ai_state PENDING', { ...AC, ai_state: 'PENDING' }],
  ['ai_state STARTED', { ...AC, ai_state: 'STARTED' }],
  ['ai_state FAILURE', { ...AC, ai_state: 'FAILURE' }],
  ['Wrong Answer', { state: 'SUCCESS', status_code: 11 }],
  ['restrictions failed (50)', { state: 'SUCCESS', status_code: 50 }],
  ['a non-JSON body', '<html>'],
]) {
  test(`nothing is announced for ${name}`, async () => {
    const res = fakeResponse(body);
    const p = page(() => Promise.resolve(res));
    await p.fetch(CHECK);
    await drain();
    assert.equal(res.clones, 1);
    assert.deepEqual(p.posted, []);
  });
}

test('ai_state SUCCESS, and Request or URL inputs, are announced', async () => {
  const p = page(() => Promise.resolve(fakeResponse({ ...AC, ai_state: 'SUCCESS' })));
  p.fetch(new Request(`${ORIGIN}/submissions/detail/11/v2/check/`));
  p.fetch(new URL(`${ORIGIN}/submissions/detail/12/v2/check/`));
  await p.next;
  await drain();
  assert.deepEqual(p.posted.map(([m]) => m.submissionId).sort(), ['11', '12']);
});
