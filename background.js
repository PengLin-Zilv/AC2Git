// Service worker. The only code that reads the token: checks it, stores it, pushes, sets the badge.

// Content scripts must not be able to read storage, and so the token, at all.
// save() waits on this, so no token is stored while they still could.
const storageLocked = chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });

const TARGET = 'leetcode-submissions';
const PATH = /^\d{4,}-[a-z0-9]+(?:-[a-z0-9]+)*\.[a-z]+$/; // repo root only: no slashes, no dotfiles
const LEETCODE_FAILED = "Not pushed: couldn't read the submission from LeetCode (its API may have changed).";

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (fromLeetCode(sender)) {
    if (msg?.type === 'push') enqueue(() => (isFile(msg) ? push(msg) : report(false, LEETCODE_FAILED)));
    if (msg?.type === 'leetcodeError') enqueue(() => report(false, LEETCODE_FAILED));
    return;
  }
  if (!fromPopup(sender)) return;
  const job = msg?.type === 'save' ? save(msg.token) : msg?.type === 'status' ? status() : null;
  if (!job) return;
  job.then(reply, () => reply({ ok: false, text: 'Something went wrong. Try again.' })); // never leave the popup waiting
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

async function save(raw) {
  const token = typeof raw === 'string' ? raw.trim() : '';
  const proof = await check(token);
  if (!proof.ok) return { ok: false, text: proof.text };
  const owner = proof.target.owner.login;
  const repo = proof.target.name;
  await storageLocked;
  await chrome.storage.local.set({ token, owner, repo });
  return { ok: true, text: `OK: token reaches only ${owner}/${repo} (${proof.checked} other repos checked). Saved.` };
}

async function status() {
  const { owner, repo, last } = await chrome.storage.local.get(['owner', 'repo', 'last']);
  return { repo: owner && repo ? `${owner}/${repo}` : null, last: last ?? null };
}

// ---- Token check
// Read-only GETs proving the token reaches your own leetcode-submissions, no other repo, and no
// SSH keys. Test & save and every push run it. → { ok: true, target, checked } or a failure.

const fail = (kind, text, status) => ({ ok: false, kind, text, status });
const githubError = (status) => fail('github', `GitHub error ${status}. Try again in a minute.`, status);

async function check(token) {
  if (!/^github_pat_\w+$/.test(token)) return fail('unusable', 'Use a fine-grained token (starts with github_pat_).');
  try {
    return await checkRepos(token);
  } catch {
    return fail('github', "Couldn't reach GitHub.", 'network');
  }
}

async function checkRepos(token) {
  const list = await gh('GET', '/user/repos?affiliation=owner&per_page=100', token);
  if (list.status === 401) return fail('revoked', 'GitHub rejected this token.');
  const repos = list.status === 200 ? await list.json().catch(() => null) : null;
  if (!Array.isArray(repos)) return githubError(list.status);
  if (/rel="next"/.test(list.headers.get('link') ?? '')) {
    return fail('unusable', 'You own over 100 repos, more than AC2Git can check.');
  }

  const target = repos.find((r) => r.name.toLowerCase() === TARGET);
  const others = repos.filter((r) => r !== target);

  // The list shows every public repo you own, but only the private repos the token was granted.
  const readable = others.find((r) => r.private);
  if (readable) {
    return fail('overScoped', `Rejected: this token can read ${readable.full_name}. Use Only select repositories → leetcode-submissions.`);
  }

  // The target goes first as a positive control: if GitHub ever changes what the probe needs,
  // the target fails too, so the check fails closed instead of passing every other repo.
  const reach = target ? await probe(token, collaborators(target)) : 'refused';
  if (reach === 'refused') {
    return fail('noTarget', "Rejected: this token can't reach your leetcode-submissions repo. Resource owner: you; Only select repositories → leetcode-submissions.");
  }
  if (reach !== 'reached') return githubError(reach);

  const keys = await probe(token, '/user/keys?per_page=1');
  if (keys === 'reached') {
    return fail('overScoped', 'Rejected: this token has the Git SSH keys permission, which reaches every repo. Set it to No access.');
  }
  if (keys !== 'refused') return githubError(keys);

  for (let i = 0; i < others.length; i += 5) {
    const batch = others.slice(i, i + 5);
    const results = await Promise.all(batch.map((r) => probe(token, collaborators(r))));
    // A proven reach outranks an error: the fix is a new token, not a retry.
    const reached = results.indexOf('reached');
    if (reached !== -1) {
      return fail('overScoped', `Rejected: this token also reaches ${batch[reached].full_name}. Use Only select repositories → leetcode-submissions.`);
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

let queue = Promise.resolve();

// One push at a time: two quick Accepted results would otherwise race on the branch (409).
function enqueue(job) {
  queue = queue.then(job).catch(() => {});
}

async function push(file) {
  const { token, owner, repo } = await chrome.storage.local.get(['token', 'owner', 'repo']);
  if (!token) return report(false, 'Not pushed: no token set. Open AC2Git and paste one.');
  const where = `${owner}/${repo}`;
  const proof = await check(token); // on a reject, storage stays as is: the next push checks again
  if (!proof.ok) return report(false, notPushed(proof, where));
  try {
    const failure = await commit(token, proof.target, file);
    return failure ? report(false, notPushed(failure, where)) : report(true, `OK ${file.path}`);
  } catch {
    return report(false, notPushed({ kind: 'github', status: 'network' }, where));
  }
}

// Writes the file into the repo check() just proved. → null once the file is in place, else a failure.
async function commit(token, target, { path, content, message }) {
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

function writeFailure(status) {
  if (status === 401) return { kind: 'revoked' };
  if (status === 403 || status === 404) return { kind: 'noTarget' };
  return { kind: 'github', status };
}

function notPushed(f, where) {
  switch (f.kind) {
    case 'revoked': return 'Not pushed: GitHub rejected the token (expired or revoked). Paste a new one.';
    case 'noTarget': return `Not pushed: token can't write to ${where}. It needs Contents: Read and write.`;
    case 'github': return `Not pushed: GitHub error ${f.status}. Submit again to retry.`;
    case 'overScoped': return `Not pushed: ${f.text.replace('Rejected: ', '')} Revoke it on GitHub and paste a new one.`;
    default: return `Not pushed: ${f.text}`;
  }
}

// ---- Badge

let clearBadge;

async function report(ok, text) {
  await chrome.storage.local.set({ last: { ok, text, at: Date.now() } });
  clearTimeout(clearBadge);
  await chrome.action.setBadgeBackgroundColor({ color: ok ? '#1a7f37' : '#cf222e' });
  await chrome.action.setBadgeText({ text: ok ? 'OK' : '!' });
  // A lasting OK would vouch for a later submission that never landed. 10 s is inside the
  // worker's 30 s idle limit, so the timer fires. A red ! stays until the next success or a browser restart.
  if (ok) clearBadge = setTimeout(() => chrome.action.setBadgeText({ text: '' }), 10_000);
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
