// background.js in a vm with a mocked chrome and a fake api.github.com. No network, no real token.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
// Chrome 140+ has Uint8Array.prototype.toBase64; Node may not. TextEncoder comes from this realm.
Uint8Array.prototype.toBase64 ??= function () { return Buffer.from(this).toString('base64'); };

const TOKEN = 'github_pat_GOOD0000';
const NEW_TOKEN = 'github_pat_NEW00000';
const SAVED = { token: TOKEN, owner: 'me', repo: 'leetcode-submissions' };
const LC = { id: 'ext', tab: { id: 1 }, frameId: 0, origin: 'https://leetcode.com' };
const POPUP = { id: 'ext', url: 'chrome-extension://ext/popup.html' };
const FILE = { type: 'push', path: '0001-two-sum.py', content: 'x = 1  # 你好 é\n', message: '1. Two Sum (Python3)' };
const NO_GRANT = { status: 403, body: { message: 'Resource not accessible by personal access token' } };
const HTML_403 = { status: 403, raw: '<!doctype html><h1>Access denied</h1>' };
const repo = (name, priv = false) => ({ name, full_name: `me/${name}`, private: priv, owner: { login: 'me' } });
const TARGET = repo('leetcode-submissions', true);
const OTHERS = ['AC2Git', 'pub-1', 'pub-2'].map((n) => repo(n));
const GOOD = () => ({ repos: [TARGET, ...OTHERS], granted: new Set([TARGET.name]) }); // a token granted only leetcode-submissions
const AC2GIT = () => ({ repos: [TARGET, ...OTHERS], granted: new Set([TARGET.name, 'AC2Git']) }); // + one other
const ALL = () => ({ repos: [TARGET, ...OTHERS], granted: new Set([TARGET, ...OTHERS].map((r) => r.name)) });

const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const reply = (o) => (o.raw !== undefined ? new Response(o.raw, { status: o.status }) : json(o.status, o.body ?? {}, o.headers));
const seen = []; // every reply, `last` and title from every world, for the secrecy test
const allRequests = []; // every request from every world, for the no-other-repo-write test
const drain = () => new Promise(setImmediate); // runs every pending promise reaction; no fixed sleep

// A fake GitHub. One scenario per bearer token; scenario fields override the default behaviour.
function fakeGitHub(scenarios) {
  const requests = [];
  const files = new Map();
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const p = u.pathname + u.search;
    const method = init.method ?? 'GET';
    const sc = scenarios[init.headers.Authorization.replace('Bearer ', '')] ?? {};
    const r = { method, p, init, body: init.body && JSON.parse(init.body) };
    requests.push(r);
    allRequests.push(r);
    await new Promise((res) => setTimeout(res, sc.latency ?? 1));
    try {
      if (sc.throwOn?.(method, p)) throw new TypeError('Failed to fetch');
      if (p.startsWith('/user/repos')) return sc.list ? reply(sc.list) : json(200, sc.repos ?? [], sc.listHeaders);
      if (p.startsWith('/user/keys')) return reply(sc.keys ?? NO_GRANT);
      let m = /^\/repos\/[^/]+\/([^/]+)\/collaborators/.exec(p);
      if (m) return sc.probe?.[m[1]] ? reply(sc.probe[m[1]]) : sc.granted?.has(m[1]) ? json(200, []) : reply(NO_GRANT);
      m = /^\/repos\/me\/leetcode-submissions\/contents\/(.+)$/.exec(p);
      if (m && method === 'GET') {
        if (sc.contents) return reply({ status: sc.contents });
        const f = files.get(m[1]);
        const wrapped = f && Buffer.from(f.content).toString('base64').replace(/(.{60})/g, '$1\n');
        return f ? json(200, { content: wrapped, sha: f.sha }) : json(404, { message: 'Not Found' });
      }
      if (m && method === 'PUT') {
        if (sc.put) return reply({ status: sc.put });
        const old = files.get(m[1]);
        if (old?.sha !== r.body.sha) return json(409, { message: 'sha mismatch' });
        files.set(m[1], { content: Buffer.from(r.body.content, 'base64').toString(), sha: `sha${requests.length}` });
        return json(old ? 200 : 201, {});
      }
      return json(404, {});
    } finally {
      r.done = true;
    }
  };
  return { fetch, requests, files };
}

// fail: flags read at call time, so a test can make remove/setTitle reject after setup.
function world({ scenarios = { [TOKEN]: GOOD() }, store = SAVED, failAccessLevel = false } = {}) {
  const fail = {};
  const accessLevels = [];
  const gh = fakeGitHub(scenarios);
  const state = structuredClone(store);
  const badge = [];
  const titles = [];
  const timers = [];
  let listener;
  const pick = (keys) => Object.fromEntries([keys].flat().filter((k) => k in state).map((k) => [k, structuredClone(state[k])]));
  const chrome = {
    runtime: { id: 'ext', getURL: (p) => `chrome-extension://ext/${p}`, onMessage: { addListener: (f) => { listener = f; } } },
    storage: {
      local: {
        setAccessLevel: (arg) => {
          accessLevels.push(structuredClone(arg)); // out of the vm realm, for deepEqual
          const p = failAccessLevel ? Promise.reject(new Error('failed')) : Promise.resolve();
          p.catch(() => {}); // pre-handled so Node doesn't flag it at load; save() still awaits it and rejects
          return p;
        },
        get: async (keys) => pick(keys),
        set: async (o) => { Object.assign(state, structuredClone(o)); seen.push(o.last); },
        remove: async (k) => { if (fail.remove) throw new Error('remove failed'); delete state[k]; },
      },
    },
    action: {
      setBadgeText: async ({ text }) => { badge.push(text); },
      setBadgeBackgroundColor: async () => {},
      setTitle: async ({ title }) => { if (fail.setTitle) throw new Error('setTitle failed'); titles.push(title); seen.push(title); },
    },
  };
  const ctx = vm.createContext({
    chrome, fetch: gh.fetch, TextEncoder, console, clearTimeout,
    setTimeout: (f, ms) => { timers.push([f, ms]); return setTimeout(() => {}, 0); }, // fired by hand
  });
  vm.runInContext(SRC, ctx);
  // Like chrome.runtime.sendMessage: undefined when the listener doesn't keep the channel open.
  const send = (msg, sender) => new Promise((resolve) => {
    if (listener(msg, sender, (r) => { seen.push(r); resolve(structuredClone(r)); }) !== true) resolve(undefined);
  });
  const idle = () => vm.runInContext('queue', ctx);
  const push = async (file = FILE) => { await send(file, LC); await idle(); };
  return { ...gh, state, badge, titles, timers, fail, accessLevels, send, push, idle, save: (t = TOKEN) => send({ type: 'save', token: t }, POPUP) };
}

const MSG = {
  M1: 'Not saved: use a fine-grained token (starts with github_pat_).',
  M2: "Not saved: couldn't reach GitHub. Check your connection and try again.",
  M3: 'Not saved: GitHub rejected this token. It may be expired, revoked or not fully copied.',
  M4: (s) => `Not saved: GitHub error ${s}. Try again in a minute.`,
  M5: 'Not saved: you own over 100 repos, more than AC2Git can check.',
  M6: (r) => `Not saved: this token can read ${r}. Delete it on GitHub and use one with Only select repositories → leetcode-submissions.`,
  M7: "Not saved: this token can't reach your leetcode-submissions repo. Check it exists and the token selects it (Resource owner: you).",
  M8: 'Not saved: this token has the Git SSH keys permission, which reaches every repo. Delete it on GitHub and use one without it.',
  M9: (r) => `Not saved: this token also reaches ${r}. Delete it on GitHub and use one with Only select repositories → leetcode-submissions.`,
};
const PUSH = {
  noToken: 'Not pushed: no token saved. Paste one in AC2Git, then submit again.',
  revoked: 'Not pushed: GitHub rejected the token (expired or revoked). Paste a new one in AC2Git, then submit again.',
  write: "Not pushed: can't write to leetcode-submissions. Check the repo exists and the token selects it with Contents: Read and write, then submit again.",
  github: (s) => `Not pushed: GitHub error ${s}. Submit again.`,
  network: "Not pushed: couldn't reach GitHub. Submit again.",
  leetcode: "Not pushed: couldn't read the submission from LeetCode. Submit again. If it keeps failing, LeetCode may have changed its API.",
  scope: (fragment) => `Not pushed: ${fragment.replace('Not saved: ', '').replace(/\.$/, ', then submit again.')}`,
};

describe('token check (Test & save): fail closed', () => {
  test('a correct token passes on GETs only, target probed first, and is stored', async () => {
    const w = world({ store: {} });
    assert.deepEqual(await w.save(), { ok: true, text: 'Saved. Reaches leetcode-submissions and none of your other repos (3 checked).' });
    assert.deepEqual(w.requests.map((r) => r.p).slice(0, 3),
      ['/user/repos?affiliation=owner&per_page=100', '/repos/me/leetcode-submissions/collaborators?per_page=1', '/user/keys?per_page=1']);
    assert.equal(w.requests.length, 6);
    for (const r of w.requests) {
      assert.equal(r.method, 'GET');
      assert.equal(r.init.cache, 'no-store');
      assert.equal(r.init.redirect, 'error');
    }
    assert.deepEqual(w.state, SAVED);
  });

  test('n = 0 claims only what the list proves', async () => {
    const w = world({ store: {}, scenarios: { [TOKEN]: { repos: [TARGET], granted: new Set([TARGET.name]) } } });
    assert.equal((await w.save()).text, 'Saved. Reaches leetcode-submissions, and no other repo of yours is visible to it.');
  });

  for (const bad of ['ghp_classic123', '', 'github_pat_a b', 'github_pat_x\r\nX-Evil: 1', 42]) {
    test(`M1 for ${JSON.stringify(bad)}, with no request`, async () => {
      const w = world({ store: {} });
      assert.deepEqual(await w.send({ type: 'save', token: bad }, POPUP), { ok: false, text: MSG.M1 });
      assert.equal(w.requests.length, 0);
    });
  }

  const rejects = [
    ['M2 network', { throwOn: () => true }, MSG.M2],
    ['M3 list 401', { list: { status: 401 } }, MSG.M3],
    ['M4 list 500', { list: { status: 500 } }, MSG.M4(500)],
    ['M4 list 200 but not an array', { list: { status: 200, body: { message: 'odd' } } }, MSG.M4(200)],
    ['M4 rate-limited probe', { ...GOOD(), probe: { 'pub-1': { status: 403, body: { message: 'API rate limit exceeded for user ID 1.' } } } }, MSG.M4(403)],
    ['M4 granted repo answering an HTML 403', { ...AC2GIT(), probe: { AC2Git: HTML_403 } }, MSG.M4(403)],
    ['M4 granted repo answering an odd JSON 403', { ...AC2GIT(), probe: { AC2Git: { status: 403, body: { message: 'Must have push access.' } } } }, MSG.M4(403)],
    ['M4 /user/keys answering an HTML 403', { ...GOOD(), keys: HTML_403 }, MSG.M4(403)],
    ['M4 /user/keys 429', { ...GOOD(), keys: { status: 429 } }, MSG.M4(429)],
    ['M4 target probe 500', { ...GOOD(), probe: { 'leetcode-submissions': { status: 500 } } }, MSG.M4(500)],
    ['M5 more than 100 repos', { ...GOOD(), listHeaders: { link: '<x?page=2>; rel="next"' } }, MSG.M5],
    ['M6 another private repo listed', { repos: [TARGET, repo('thesis', true)], granted: new Set([TARGET.name, 'thesis']) }, MSG.M6('me/thesis')],
    ['M7 target not listed', { repos: OTHERS }, MSG.M7],
    ['M7 target refused (exact no-grant 403)', { ...GOOD(), granted: new Set() }, MSG.M7],
    ['M7 target 404', { ...GOOD(), probe: { 'leetcode-submissions': { status: 404 } } }, MSG.M7],
    ['M8 SSH keys reachable', { ...GOOD(), keys: { status: 200, body: [] } }, MSG.M8],
    ['M9 another repo reachable', ALL(), MSG.M9('me/AC2Git')],
    ['M9 outranks an error in the same batch', { ...GOOD(), granted: new Set([TARGET.name, 'pub-2']), probe: { 'pub-1': { status: 429 } } }, MSG.M9('me/pub-2')],
    ['M2 on a redirect (never followed)', { ...GOOD(), throwOn: (m, p) => p.includes('/pub-1/') }, MSG.M2],
  ];
  for (const [name, scenario, text] of rejects) {
    test(`${name}: rejected, nothing stored, GETs only`, async () => {
      const w = world({ store: {}, scenarios: { [TOKEN]: scenario } });
      assert.deepEqual(await w.save(), { ok: false, text });
      assert.deepEqual(w.state, {});
      assert.ok(w.requests.every((r) => r.method === 'GET'));
    });
  }

  test('"refused" is a 404 or the exact no-grant 403: 404s on other repos and keys still pass', async () => {
    const probe = { AC2Git: { status: 404 }, 'pub-1': { status: 404 } };
    const w = world({ store: {}, scenarios: { [TOKEN]: { ...GOOD(), probe, keys: { status: 404 } } } });
    assert.equal((await w.save()).ok, true);
  });

  test('a failed save keeps the previous token', async () => {
    const w = world({ scenarios: { [NEW_TOKEN]: ALL() } });
    assert.equal((await w.save(NEW_TOKEN)).ok, false);
    assert.deepEqual(w.state, SAVED);
  });

  test('setAccessLevel failing means nothing is stored', async () => {
    const w = world({ store: {}, failAccessLevel: true });
    assert.deepEqual(await w.save(), { ok: false, text: 'Not saved: something went wrong. Try again.' });
    assert.deepEqual(w.state, {});
  });

  test('save race: a slow older save never overwrites a newer one', async () => {
    const B = { ...TARGET, owner: { login: 'bee' }, full_name: 'bee/leetcode-submissions' };
    const w = world({ store: {}, scenarios: { [TOKEN]: { ...GOOD(), latency: 30 }, [NEW_TOKEN]: { repos: [B], granted: new Set([B.name]) } } });
    const a = w.save(TOKEN);
    await drain(); // A's check is under way (30 ms a request); B's takes 1 ms a request
    assert.equal((await w.save(NEW_TOKEN)).ok, true);
    assert.deepEqual(await a, { ok: false, text: 'Not saved: a newer token was submitted.' });
    assert.deepEqual(w.state, { token: NEW_TOKEN, owner: 'bee', repo: 'leetcode-submissions' });
  });
});

describe('push', () => {
  const puts = (w) => w.requests.filter((r) => r.method === 'PUT');

  test('new file: re-check first, then one PUT without sha, exact UTF-8 base64, green OK', async () => {
    const w = world();
    await w.push();
    assert.equal(w.requests[0].p, '/user/repos?affiliation=owner&per_page=100');
    assert.equal(puts(w).length, 1);
    assert.deepEqual(puts(w)[0].body, { message: FILE.message, content: Buffer.from(FILE.content).toString('base64') });
    assert.equal(w.files.get(FILE.path).content, FILE.content);
    assert.equal(w.state.last.text, 'OK 0001-two-sum.py');
    assert.deepEqual(w.badge, ['OK']);
    assert.deepEqual(w.titles, ['AC2Git – OK 0001-two-sum.py']);
  });

  test('identical content: no PUT; changed content: PUT with the sha', async () => {
    const w = world();
    w.files.set(FILE.path, { content: FILE.content, sha: 'sha-old' });
    await w.push();
    assert.equal(puts(w).length, 0);
    await w.push({ ...FILE, content: 'y = 2\n' });
    assert.equal(puts(w)[0].body.sha, 'sha-old');
  });

  test('the token check runs again before every push', async () => {
    const w = world();
    await w.push();
    await w.push({ ...FILE, path: '0002-add-two-numbers.py' });
    const order = w.requests.map((r) => (r.p.startsWith('/user/repos') ? 'check' : r.method === 'PUT' ? 'put' : null)).filter(Boolean);
    assert.deepEqual(order, ['check', 'put', 'check', 'put']);
  });

  test('two concurrent pushes run one after the other', async () => {
    const w = world();
    await w.send(FILE, LC);
    await w.send({ ...FILE, path: '0002-add-two-numbers.py' }, LC);
    await w.idle();
    const firstPut = w.requests.findIndex((r) => r.method === 'PUT');
    const secondCheck = w.requests.findLastIndex((r) => r.p.startsWith('/user/repos'));
    assert.ok(secondCheck > firstPut, 'second check starts after the first PUT');
    assert.equal(w.files.size, 2);
  });

  const failures = [
    ['PUT 401', { ...GOOD(), put: 401 }, PUSH.revoked],
    ['PUT 403', { ...GOOD(), put: 403 }, PUSH.write],
    ['PUT 404', { ...GOOD(), put: 404 }, PUSH.write],
    ['PUT 409', { ...GOOD(), put: 409 }, PUSH.github(409)],
    ['PUT network', { ...GOOD(), throwOn: (m) => m === 'PUT' }, PUSH.network],
    ['contents GET 500', { ...GOOD(), contents: 500 }, PUSH.github(500)],
  ];
  for (const [name, scenario, text] of failures) {
    test(`${name} → "${text.slice(12, 50)}…", red !`, async () => {
      const w = world({ scenarios: { [TOKEN]: scenario } });
      await w.push();
      assert.equal(w.state.last.text, text);
      assert.deepEqual(w.badge, ['!']);
      assert.deepEqual(w.titles, [`AC2Git – ${text}`]);
    });
  }

  const recheck = [
    ['M3', { list: { status: 401 } }, PUSH.revoked],
    ['M4', { list: { status: 503 } }, PUSH.github(503)],
    ['M2', { throwOn: () => true }, PUSH.network],
    ['M5', { ...GOOD(), listHeaders: { link: '<x>; rel="next"' } }, 'Not pushed: you own over 100 repos, more than AC2Git can check.'],
    ['M6', { repos: [TARGET, repo('thesis', true)] }, PUSH.scope(MSG.M6('me/thesis'))],
    ['M7', { ...GOOD(), granted: new Set() }, PUSH.write],
    ['M8', { ...GOOD(), keys: { status: 200, body: [] } }, PUSH.scope(MSG.M8)],
    ['M9 (token edited to All repositories)', ALL(), PUSH.scope(MSG.M9('me/AC2Git'))],
    ['HTML 403 on a granted repo', { ...AC2GIT(), probe: { AC2Git: HTML_403 } }, PUSH.github(403)],
  ];
  for (const [name, scenario, text] of recheck) {
    test(`re-check ${name} refuses the push: no contents request, no PUT, token kept`, async () => {
      const w = world({ scenarios: { [TOKEN]: scenario } });
      await w.push();
      assert.ok(w.requests.every((r) => r.method === 'GET' && !r.p.includes('/contents/')));
      assert.equal(w.state.last.text, text);
      assert.equal(w.state.token, TOKEN);
    });
  }

  test('no token saved', async () => {
    const w = world({ store: {} });
    await w.push();
    assert.equal(w.requests.length, 0);
    assert.equal(w.state.last.text, PUSH.noToken);
  });

  for (const [name, msg] of [
    ['path traversal', { ...FILE, path: '../0001-x.py' }],
    ['dotfile path', { ...FILE, path: '.github/workflows/x.yml' }],
    ['newline in the message', { ...FILE, message: '1. Two Sum\nSigned-off-by: x' }],
    ['non-string content', { ...FILE, content: {} }],
    ['leetcodeError', { type: 'leetcodeError' }],
  ]) {
    test(`${name} → LeetCode text, no request`, async () => {
      const w = world();
      await w.push(msg);
      assert.equal(w.requests.length, 0);
      assert.equal(w.state.last.text, PUSH.leetcode);
    });
  }

  for (const [name, sender] of [
    ['another origin', { ...LC, origin: 'https://evil.example' }],
    ['a subframe', { ...LC, frameId: 2 }],
    ['another extension', { ...LC, id: 'other' }],
    ['the popup', POPUP],
  ]) {
    test(`a push from ${name} is ignored`, async () => {
      const w = world();
      assert.equal(await w.send(FILE, sender), undefined);
      await w.idle();
      assert.equal(w.requests.length, 0);
      assert.equal(w.state.last, undefined);
    });
  }

  test('save and status from a tab get no reply', async () => {
    const w = world();
    assert.equal(await w.send({ type: 'status' }, LC), undefined);
    assert.equal(await w.send({ type: 'save', token: TOKEN }, LC), undefined);
    assert.equal(w.requests.length, 0);
  });

  test('a green OK clears badge and title after 10 s; a red ! has no timer', async () => {
    const w = world();
    await w.push();
    const [clear, ms] = w.timers.at(-1);
    assert.equal(ms, 10_000);
    await clear();
    assert.deepEqual(w.badge, ['OK', '']);
    assert.deepEqual(w.titles.at(-1), 'AC2Git');
    const bad = world({ scenarios: { [TOKEN]: { ...GOOD(), put: 500 } } });
    await bad.push();
    assert.equal(bad.timers.length, 0);
  });
});

describe('a saved token clears stale token failures', () => {
  const tokenFailures = [
    ['401 (expired or revoked)', { list: { status: 401 } }, SAVED],
    ['over-scoped (M9)', ALL(), SAVED],
    ["can't reach the target at the re-check (M7)", { ...GOOD(), granted: new Set() }, SAVED],
    ['no token saved', {}, {}],
  ];
  for (const [name, scenario, store] of tokenFailures) {
    test(`${name}: after a good save, last is gone and the badge and title reset`, async () => {
      const w = world({ store, scenarios: { [TOKEN]: scenario, [NEW_TOKEN]: GOOD() } });
      await w.push();
      assert.equal(w.badge.at(-1), '!');
      assert.equal((await w.save(NEW_TOKEN)).ok, true);
      assert.equal(w.state.last, undefined);
      assert.equal(w.badge.at(-1), '');
      assert.equal(w.titles.at(-1), 'AC2Git');
      assert.deepEqual(await w.send({ type: 'status' }, POPUP), { repo: 'me/leetcode-submissions', last: null });
    });
  }

  const otherFailures = [
    ['GitHub error', { ...GOOD(), put: 500 }, () => {}],
    ["can't write (PUT 403: the check can't prove Contents: write)", { ...GOOD(), put: 403 }, () => {}],
    ["can't write (contents GET 403)", { ...GOOD(), contents: 403 }, () => {}],
    ['network', { ...GOOD(), throwOn: (m) => m === 'PUT' }, () => {}],
    ['LeetCode', GOOD(), (w) => w.push({ type: 'leetcodeError' })],
  ];
  for (const [name, scenario, fail] of otherFailures) {
    test(`${name} failure stays after a good save: a new token doesn't fix it`, async () => {
      const w = world({ scenarios: { [TOKEN]: scenario, [NEW_TOKEN]: GOOD() } });
      await (name === 'LeetCode' ? fail(w) : w.push());
      const before = w.state.last;
      assert.equal((await w.save(NEW_TOKEN)).ok, true);
      assert.deepEqual(w.state.last, before);
      assert.equal(w.badge.at(-1), '!');
    });
  }

  test('a write failure is recorded as noWrite, with the same text as noTarget', async () => {
    const w = world({ scenarios: { [TOKEN]: { ...GOOD(), put: 403 } } });
    await w.push();
    assert.deepEqual([w.state.last.kind, w.state.last.text], ['noWrite', PUSH.write]);
  });

  test('a push in flight on the old revoked token cannot re-report after the save clears', async () => {
    const w = world({ scenarios: { [TOKEN]: { list: { status: 401 }, latency: 30 }, [NEW_TOKEN]: GOOD() } });
    await w.send(FILE, LC); // queued; its check is now waiting on GitHub
    await drain();
    assert.equal((await w.save(NEW_TOKEN)).ok, true);
    await w.idle();
    assert.equal(w.state.last, undefined);
    assert.equal(w.badge.at(-1), '');
    assert.equal(w.state.token, NEW_TOKEN);
  });

  for (const step of ['remove', 'setTitle']) {
    test(`a failed clear (${step} rejects) still saves: the reply is a pass and the token is stored`, async () => {
      const w = world({ scenarios: { [TOKEN]: { list: { status: 401 } }, [NEW_TOKEN]: GOOD() } });
      await w.push();
      w.fail[step] = true;
      const reply = await w.save(NEW_TOKEN);
      assert.equal(reply.ok, true, reply.text);
      assert.equal(w.state.token, NEW_TOKEN);
    });
  }

  test('a rejected save clears nothing', async () => {
    const w = world({ scenarios: { [TOKEN]: { list: { status: 401 } }, [NEW_TOKEN]: ALL() } });
    await w.push();
    assert.equal((await w.save(NEW_TOKEN)).ok, false);
    assert.equal(w.state.last.text, PUSH.revoked);
    assert.equal(w.badge.at(-1), '!');
  });

  test('the failure kind reaches only the popup: content scripts get no reply at all', async () => {
    const w = world({ scenarios: { [TOKEN]: { list: { status: 401 } } } });
    assert.equal(await w.send(FILE, LC), undefined);
    await w.idle();
    assert.equal(w.state.last.kind, 'revoked');
    assert.equal(await w.send({ type: 'status' }, LC), undefined);
    assert.equal((await w.send({ type: 'status' }, POPUP)).last.kind, 'revoked');
  });
});

test('token secrecy: no reply, last or title from any test above contains a token', (t) => {
  if (!seen.length) return t.skip('run the full suite');
  const leaked = seen.filter((v) => [TOKEN, NEW_TOKEN].some((t) => JSON.stringify(v ?? null).includes(t)));
  assert.deepEqual(leaked, []);
});

test('storage is locked to trusted contexts at load', () => {
  assert.deepEqual(world().accessLevels, [{ accessLevel: 'TRUSTED_CONTEXTS' }]);
});

test('no write ever goes anywhere but a file at the root of me/leetcode-submissions', (t) => {
  const writes = allRequests.filter((r) => r.method !== 'GET');
  if (!writes.length) return t.skip('run the full suite');
  for (const r of writes) assert.match(r.p, /^\/repos\/me\/leetcode-submissions\/contents\/[^/]+$/, `${r.method} ${r.p}`);
});
