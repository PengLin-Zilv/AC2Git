// content.js in a vm isolated world: verify the hint through LeetCode GraphQL, then hand background.js a file.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
const ORIGIN = 'https://leetcode.com';
const HINT = { source: 'ac2git', type: 'accepted', submissionId: '2156492751' };
const SUB = { code: 'print(1)\n', statusCode: 10, lang: { name: 'python3', verboseName: 'Python3' },
  question: { questionFrontendId: '1', title: 'Two Sum', titleSlug: 'two-sum' } };
// Pre-parsed answers and an immediate retry delay: a whole hint runs on promise reactions alone.
const gql = (details, status = 200) => ({ ok: status < 400, status, json: async () => ({ data: { submissionDetails: details } }) });
const NOT_JSON = { ok: true, status: 200, json: async () => { throw new SyntaxError('<html>'); } };
const drain = () => new Promise(setImmediate); // runs every pending promise reaction; no fixed sleep

// graphql(n) answers the n-th query. t.sending resolves when content.js calls sendMessage.
function tab(graphql, { cookie = 'a=1; csrftoken=abc123', sendThrows = false } = {}) {
  const sent = [];
  const queries = [];
  let onMessage;
  let sendCalled;
  const sending = new Promise((r) => { sendCalled = r; });
  const window = { addEventListener: (type, f) => { if (type === 'message') onMessage = f; } };
  const chrome = { runtime: { sendMessage: (m) => {
    sendCalled();
    if (sendThrows) throw new Error('Extension context invalidated.');
    sent.push(structuredClone(m));
    return Promise.reject(new Error('no reply')); // background.js never answers content scripts
  } } };
  const fetch = async (url, init) => { queries.push({ url, init, body: JSON.parse(init.body) }); return graphql(queries.length); };
  vm.runInContext(SRC, vm.createContext({ window, location: { origin: ORIGIN }, document: { cookie }, fetch, chrome, setTimeout: (f) => f() }));
  const post = (data, event = {}) => onMessage({ source: window, origin: ORIGIN, data, ...event });
  return { sent, queries, post, window, sending };
}

test('an accepted hint → same-origin GraphQL with an ID! string and the csrf header → push', async () => {
  const t = tab(() => gql(SUB));
  t.post(HINT);
  await t.sending;
  const [q] = t.queries;
  assert.equal(q.url, 'https://leetcode.com/graphql/');
  assert.equal(q.init.headers['x-csrftoken'], 'abc123');
  assert.equal(q.init.credentials, undefined); // default same-origin: the session cookie goes along
  assert.match(q.body.query, /query ac2git\(\$id: ID!\) \{\s+submissionDetails\(submissionIdV2: \$id\)/);
  assert.deepEqual(q.body.variables, { id: '2156492751' });
  assert.deepEqual(t.sent, [{ type: 'push', path: '0001-two-sum.py', content: 'print(1)\n', message: '1. Two Sum (Python3)' }]);
});

test('paths and extensions: padded ids, SQL, unknown and prototype language names', async () => {
  for (const [lang, q, want] of [
    [{ name: 'mysql', verboseName: 'MySQL' }, { questionFrontendId: '175', title: 'Combine Two Tables', titleSlug: 'combine-two-tables' }, '0175-combine-two-tables.sql'],
    [{ name: 'newlang', verboseName: 'X' }, SUB.question, '0001-two-sum.txt'],
    [{ name: 'constructor', verboseName: 'X' }, SUB.question, '0001-two-sum.txt'],
    [SUB.lang, { questionFrontendId: '10000', title: 'Big', titleSlug: 'big' }, '10000-big.py'],
  ]) {
    const t = tab(() => gql({ ...SUB, lang, question: q }));
    t.post(HINT);
    await t.sending;
    assert.equal(t.sent[0].path, want);
  }
});

test('not Accepted according to GraphQL: nothing is sent', async () => {
  const t = tab(() => gql({ ...SUB, statusCode: 11 }));
  t.post(HINT);
  await drain();
  assert.deepEqual(t.sent, []);
});

test('still judging or a transient failure is retried, up to 3 queries', async () => {
  const flaky = [gql({ ...SUB, statusCode: 0 }), gql(SUB, 503)];
  const t = tab((n) => flaky[n - 1] ?? gql(SUB));
  t.post(HINT);
  await t.sending;
  assert.equal(t.queries.length, 3);
  assert.equal(t.sent[0].type, 'push');
  for (const first of [() => { throw new TypeError('Failed to fetch'); }, () => NOT_JSON, () => gql(null)]) {
    const r = tab(first);
    r.post(HINT);
    await r.sending;
    assert.equal(r.queries.length, 3);
    assert.deepEqual(r.sent, [{ type: 'leetcodeError' }]);
  }
});

test('an unexpected shape fails closed after one query', async () => {
  for (const bad of [{ questionFrontendId: 'LCP 01' }, { questionFrontendId: 1 }, { titleSlug: '../x' }]) {
    const t = tab(() => gql({ ...SUB, question: { ...SUB.question, ...bad } }));
    t.post(HINT);
    await t.sending;
    assert.equal(t.queries.length, 1);
    assert.deepEqual(t.sent, [{ type: 'leetcodeError' }]);
  }
});

test('forged or foreign messages are ignored: no query, nothing sent', async () => {
  for (const [data, event] of [
    [HINT, { source: {} }],
    [HINT, { origin: 'https://evil.example' }],
    [{ ...HINT, source: 'x' }],
    [{ ...HINT, type: 'x' }],
    [{ ...HINT, submissionId: 5 }],
    [{ ...HINT, submissionId: '5 OR 1' }],
    [{ ...HINT, submissionId: '1'.repeat(21) }],
    [null],
  ]) {
    const t = tab(() => gql(SUB));
    t.post(data, event);
    await drain();
    assert.equal(t.queries.length + t.sent.length, 0, JSON.stringify(data));
  }
});

test('a reloaded extension (sendMessage throws) does not throw, and no rejection is left unhandled', async (t) => {
  let unhandled = 0;
  const count = () => unhandled++;
  process.on('unhandledRejection', count);
  t.after(() => process.off('unhandledRejection', count));
  const throwing = tab(() => gql(SUB), { sendThrows: true });
  assert.doesNotThrow(() => throwing.post(HINT));
  await throwing.sending;
  await drain(); // let any stray rejection surface
  assert.equal(throwing.queries.length, 1);
  assert.equal(unhandled, 0);
});

test('no csrftoken cookie: an empty header, and the query still goes', async () => {
  const t = tab(() => gql(SUB), { cookie: 'a=1' });
  t.post(HINT);
  await t.sending;
  assert.equal(t.queries[0].init.headers['x-csrftoken'], '');
  assert.equal(t.sent.length, 1);
});
