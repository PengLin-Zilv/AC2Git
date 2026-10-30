// Service worker. The only code that reads the token: checks it, stores it, pushes, sets the badge.
importScripts('outbox.js');

// Content scripts must not be able to read storage, and so the token, at all.
// save() waits on this, so no token is stored while they still could.
const storageLocked = chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });

const TARGET = 'leetcode-submissions';
const PATH = /^\d{4,}-[a-z0-9]+(?:-[a-z0-9]+)*\.[a-z]+$/; // repo root only: no slashes, no dotfiles
const LEETCODE_FAILED = "Not pushed: couldn't read the submission from LeetCode. Submit again. If it keeps failing, LeetCode may have changed its API.";
const RETRY_DELAY_MS = 1000;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (fromLeetCode(sender)) {
    // status() returns the repo and the last result, never the token. The content script asks
    // before it reads a solution, so nothing is fetched until a repo is saved.
    if (msg?.type === 'status') {
      status().then(sendResponse, () => sendResponse({ repo: null, last: null }));
      return true;
    }
    if (msg?.type === 'push' || msg?.type === 'leetcodeError') {
      // return true keeps the reply channel, and this worker, open until sendResponse.
      // A returned Promise needs Chrome 148. fetch alone does not reset the 30s idle timer.
      onLeetCode(msg).then(sendResponse, () => {
        sendResponse({ ok: false });
        report(false, msg?.type === 'push' ? pendingText(null) : LEETCODE_FAILED).catch(() => {});
      });
      return true;
    }
    return;
  }
  if (!fromPopup(sender)) return;
  const job = msg?.type === 'save' ? save(msg.token) : msg?.type === 'status' ? status() : null;
  if (!job) return;
  // Never leave the popup waiting. Only a save shows this text; a failed status shows the popup's own.
  job.then(sendResponse, () => sendResponse({ ok: false, text: 'Not saved: something went wrong. Try again.' }));
  return true; // keeps the channel open for the async reply; returning a Promise needs Chrome 148+
});

function fromLeetCode(s) {
  return s.id === chrome.runtime.id && Boolean(s.tab) && s.frameId === 0 && s.origin === 'https://leetcode.com';
}

function fromPopup(s) {
  return s.id === chrome.runtime.id && !s.tab && s.url === chrome.runtime.getURL('popup.html');
}

function isFile(m) {
  return typeof m.path === 'string' && PATH.test(m.path) && typeof m.content === 'string' &&
    typeof m.message === 'string' && m.message.length <= 300 && !/[\r\n]/.test(m.message);
}

// ---- Popup

let saves = 0; // a check can outlast its popup: only the newest save may store

async function save(raw) {
  const token = typeof raw === 'string' ? raw.trim() : '';
  const seq = ++saves;
  const proof = await check(token);
  if (seq !== saves) return { ok: false, text: 'Not saved: a newer token was submitted.' };
  if (!proof.ok) return { ok: false, text: `Not saved: ${proof.text}` };
  const { owner: { login: owner }, name: repo } = proof.target;
  await storageLocked;
  await chrome.storage.local.set({ token, owner, repo });
  // A saved token is what a held submission was waiting on. Don't block the popup on the push.
  enqueue(async () => {
    paused.clear();
    await processOutbox({ includeHeld: true });
  });
  const reaches = proof.checked ? `Saved. Reaches ${repo} and none of your other repos (${proof.checked} checked).`
    : `Saved. Reaches ${repo}, and no other repo of yours is visible to it.`;
  return { ok: true, text: `${reaches} Reload any open LeetCode tabs, then Submit (not Run).` };
}

async function status() {
  const { owner, repo, last } = await chrome.storage.local.get(['owner', 'repo', 'last']);
  return { repo: owner && repo ? `${owner}/${repo}` : null, last: last ?? null };
}

// ---- Token check
// Read-only GETs proving the token reaches your own leetcode-submissions, no other repo, and no SSH keys.
// Test & save and every push run it. → { ok: true, target, checked: listed other repos (public + granted private) } or a failure.
// Failure texts are "reason. Fix." fragments; save() and notPushed() add the outcome word.

const fail = (kind, text, status) => ({ ok: false, kind, text, status });
const githubError = (status) => fail('github', `GitHub error ${status}. Try again in a minute.`, status);
const ONLY_SELECT = 'Delete it on GitHub and use one with Only select repositories → leetcode-submissions.';

async function check(token) {
  if (!/^github_pat_\w+$/.test(token)) return fail('unusable', 'use a fine-grained token (starts with github_pat_).');
  try {
    return await checkRepos(token);
  } catch {
    return fail('github', "couldn't reach GitHub. Check your connection and try again.", 'network');
  }
}

async function checkRepos(token) {
  const list = await gh('GET', '/user/repos?affiliation=owner&per_page=100', token);
  if (list.status === 401) return fail('revoked', 'GitHub rejected this token. It may be expired, revoked or not fully copied.');
  const repos = list.status === 200 ? await list.json().catch(() => null) : null;
  if (!Array.isArray(repos)) return githubError(list.status);
  if (/rel="next"/.test(list.headers.get('link') ?? '')) {
    return fail('unusable', 'you own over 100 repos, more than AC2Git can check.');
  }

  const target = repos.find((r) => r.name.toLowerCase() === TARGET);
  const others = repos.filter((r) => r !== target);

  // The list shows every public repo you own, but only the private repos the token was granted.
  const readable = others.find((r) => r.private);
  if (readable) {
    return fail('overScoped', `this token can read ${readable.full_name}. ${ONLY_SELECT}`);
  }

  // The target goes first as a positive control: if GitHub ever changes what the probe needs,
  // the target fails too, so the check fails closed instead of passing every other repo.
  const reach = target ? await probe(token, collaborators(target)) : 'refused';
  if (reach === 'refused') {
    return fail('noTarget', "this token can't reach your leetcode-submissions repo. Check it exists and the token selects it (Resource owner: you).");
  }
  if (reach !== 'reached') return githubError(reach);

  const keys = await probe(token, '/user/keys?per_page=1');
  if (keys === 'reached') {
    return fail('overScoped', 'this token has the Git SSH keys permission, which reaches every repo. Delete it on GitHub and use one without it.');
  }
  if (keys !== 'refused') return githubError(keys);

  for (let i = 0; i < others.length; i += 5) {
    const batch = others.slice(i, i + 5);
    const results = await Promise.all(batch.map((r) => probe(token, collaborators(r))));
    // A proven reach outranks an error: the fix is a new token, not a retry.
    const reached = results.indexOf('reached');
    if (reached !== -1) {
      return fail('overScoped', `this token also reaches ${batch[reached].full_name}. ${ONLY_SELECT}`);
    }
    const error = results.find((result) => result !== 'refused');
    if (error !== undefined) return githubError(error);
  }
  return { ok: true, target, checked: others.length };
}

const repoPath = (r) => `/repos/${encodeURIComponent(r.owner.login)}/${encodeURIComponent(r.name)}`;

// Needs Metadata: read plus write access to the repo, which its owner always has. So on a repo
// you own, 200 means the token was granted it; public visibility alone gets a 403.
const collaborators = (r) => `${repoPath(r)}/collaborators?per_page=1`;

// → 'reached' (200), 'refused' (404, or a 403 with GitHub's no-grant text), or any other HTTP status.
// Refusal must be proven: any other 403 (rate limit, HTML error page, other text) fails closed.
async function probe(token, path) {
  const r = await gh('GET', path, token);
  if (r.status === 200) return 'reached';
  if (r.status === 404) return 'refused';
  const body = r.status === 403 ? await r.json().catch(() => null) : null;
  return body?.message === 'Resource not accessible by personal access token' ? 'refused' : r.status;
}

// ---- Push
// The file is in chrome.storage.local before any GitHub call, and removed only after a confirmed
// write or an identical-content skip. One push at a time: two accepts would otherwise race the branch (409).

let queue = Promise.resolve();
let pendingLock = Promise.resolve();
const paused = new Set(); // failed this wake, so one drain doesn't hot-loop. The next wake starts empty.

function enqueue(job) {
  const run = queue.then(job);
  queue = run.then(() => {}, () => {});
  return run;
}

function loadPending() {
  return chrome.storage.local.get('pending').then(({ pending }) => (Array.isArray(pending) ? pending : []));
}

// The lock covers the storage update only. GitHub calls stay outside it, so a second accept is
// on disk while the first push is still on the network.
function mutate(fn) {
  const run = pendingLock.then(async () => {
    await storageLocked;
    const items = await loadPending();
    const next = fn(items);
    if (next !== items) await chrome.storage.local.set({ pending: next });
    return next;
  });
  pendingLock = run.then(() => {}, () => {});
  return run;
}

function onLeetCode(msg) {
  if (msg?.type === 'leetcodeError' || !isFile(msg)) {
    return enqueue(() => report(false, LEETCODE_FAILED)).then(() => ({ ok: false }));
  }
  const file = { path: msg.path, content: msg.content, message: msg.message };
  const stored = mutate((items) => addItem(items, file));
  return enqueue(async () => {
    await stored;
    paused.clear(); // this accept is a reason to try again, including a file held for a bad token
    await processOutbox({ includeHeld: true });
  }).then(() => ({ ok: true }));
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Extension API calls reset the 30s idle timer; fetch does not. save() replies before a resumed
// push finishes, so that path has no open message channel keeping the worker alive.
function holdWorker() {
  const timer = setInterval(() => { chrome.runtime.getPlatformInfo(() => {}); }, 20_000);
  return () => clearInterval(timer);
}

async function processOutbox({ includeHeld = false, announce = false } = {}) {
  const release = holdWorker();
  try {
    if (announce && nextItem(await loadPending(), { includeHeld, paused })) await report(false, pendingText(null));
    for (;;) {
      const item = nextItem(await loadPending(), { includeHeld, paused });
      if (!item) return;
      if (!isFile(item)) {
        paused.add(itemKey(item));
        await mutate((items) => removeItem(items, item));
        await report(false, LEETCODE_FAILED);
        continue;
      }
      await deliver(item);
    }
  } catch {
    await report(false, pendingText(null)).catch(() => {});
  } finally {
    release();
  }
}

async function deliver(item) {
  let attempt = 0;
  let push = null; // { token, target } once check() passes. Write retries reuse it and do not re-probe.
  try {
    for (;;) {
      attempt += 1;
      let failure;
      if (!push) {
        const opened = await openPush();
        if (opened.failure) failure = opened.failure;
        else {
          push = opened.push;
          failure = await writePush(push, item);
        }
      } else failure = await writePush(push, item);
      if (failure && isPermanentKind(failure.kind)) push = null;
      if (await settle(item, failure, attempt)) return;
    }
  } catch {
    paused.add(itemKey(item));
    const still = (await loadPending().catch(() => [])).some((stored) => sameFile(stored, item));
    if (still) await report(false, pendingText(null)).catch(() => {});
  }
}

async function openPush() {
  const { token } = await chrome.storage.local.get('token');
  if (!token) return { failure: { kind: 'noToken' } };
  const proof = await check(token); // on a reject, storage stays as is: the next push checks again
  if (!proof.ok) return { failure: proof };
  return { push: { token, target: proof.target } };
}

async function writePush(push, file) {
  try {
    return await commit(push.token, push.target, file); // null once the file is on GitHub
  } catch {
    return { kind: 'github', status: 'network' };
  }
}

// true once this file is done for the wake: on GitHub, held for the user, or waiting for the next wake.
async function settle(item, failure, attempt) {
  const decision = decide(failure, attempt);
  if (decision.action === 'retry') {
    await delay(RETRY_DELAY_MS);
    return false;
  }
  if (decision.action === 'clear') {
    await mutate((items) => removeItem(items, item));
    await report(true, `OK ${item.path}`);
    return true;
  }
  paused.add(itemKey(item));
  if (decision.action === 'hold') {
    await report(false, notPushed(failure), { revoked: decision.revoked });
    await mutate((items) => markHeld(items, item, true)).catch(() => {});
    return true;
  }
  await report(false, pendingText(failure));
  return true;
}

// Writes the file into the repo check() just proved. → null once the file is in place, else a failure.
// 409/422 is almost always a stale sha, so re-read the file once before counting the write as failed.
async function commit(token, target, file) {
  const failure = await putContents(token, target, file);
  return isShaConflict(failure?.status) ? putContents(token, target, file) : failure;
}

async function putContents(token, target, { path, content, message }) {
  const url = `${repoPath(target)}/contents/${path}`;
  const b64 = new TextEncoder().encode(content).toBase64();
  const current = await gh('GET', url, token);
  if (current.status !== 200 && current.status !== 404) return writeFailure(current.status);
  const existing = current.status === 200 ? await current.json() : null;
  // GitHub wraps base64 every 60 chars. Base64 is canonical, so equal strings mean equal bytes.
  if (typeof existing?.content === 'string' && existing.content.replace(/\s/g, '') === b64) return null;
  // A new file has no sha, and JSON.stringify drops the undefined field.
  const put = await gh('PUT', url, token, { message, content: b64, sha: existing?.sha });
  return put.status === 200 || put.status === 201 ? null : writeFailure(put.status);
}

// Permanent failures stay pending until a new token is saved or another submission is pushed.
function notPushed(f) {
  switch (f.kind) {
    case 'revoked': return 'Not pushed: GitHub rejected the token (expired or revoked). Paste a new one in AC2Git. Pending, will retry.';
    case 'noToken': return 'Not pushed: no token saved. Paste one in AC2Git. Pending, will retry.';
    case 'noTarget': return "Not pushed: can't write to leetcode-submissions. Check the repo exists and the token selects it with Contents: Read and write, then submit again.";
    case 'github': return f.status === 'network' ? "Not pushed: couldn't reach GitHub. Submit again." : `Not pushed: GitHub error ${f.status}. Submit again.`;
    case 'overScoped': return `Not pushed: ${f.text.replace(/\.$/, ', then submit again.')}`;
    default: return `Not pushed: ${f.text || 'something went wrong.'}`;
  }
}

// ---- Badge

let clearBadge;

async function report(ok, text, flags) {
  const last = { ok, text, at: Date.now() };
  if (flags?.revoked) last.revoked = true; // the popup offers the same pre-filled token link
  await chrome.storage.local.set({ last });
  clearTimeout(clearBadge);
  await chrome.action.setBadgeBackgroundColor({ color: ok ? '#1a7f37' : '#cf222e' });
  await chrome.action.setBadgeText({ text: ok ? 'OK' : '!' });
  await chrome.action.setTitle({ title: `AC2Git – ${text}` }); // the badge in words; also the button's accessible name
  // A lasting OK would vouch for a later submission that never landed. 10 s is inside the
  // worker's 30 s idle limit, so the timer fires. A red ! stays until the next success or a browser restart.
  if (ok) clearBadge = setTimeout(() => { chrome.action.setBadgeText({ text: '' }); chrome.action.setTitle({ title: 'AC2Git' }); }, 10_000);
}

// ---- GitHub

function gh(method, path, token, body) {
  return fetch(`https://api.github.com${path}`, {
    method,
    cache: 'no-store', // GitHub sends max-age=60; a cached GET could give a stale sha (409) or a stale check
    redirect: 'error', // a redirect would replay the request, token and body to a URL we didn't build
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2026-03-10',
      ...(body && { 'Content-Type': 'application/json' }),
    },
    body: body && JSON.stringify(body),
  });
}

// Held files (revoked, too-broad, no repo) wait for the next accept or a new token, so a 401
// does not retry on every popup open. A wake with nothing pending is one storage read.
enqueue(() => processOutbox({ includeHeld: false, announce: true }));
