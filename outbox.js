// Pure outbox decisions. No chrome.* — the service worker importScripts this, and node:test requires it.
// An accepted file stays in `pending` until GitHub confirms it. Auth and scope failures are held
// so a wake does not retry them; everything else gets a bounded number of tries, then waits for the next wake.

var OUTBOX_ATTEMPTS = 3;

function isPermanentKind(kind) {
  return kind === 'revoked' || kind === 'overScoped' || kind === 'noTarget' || kind === 'unusable' || kind === 'noToken';
}

function isShaConflict(status) {
  return status === 409 || status === 422;
}

// 401 is the token. 403/404 is the repo or its Contents permission. Anything else can be transient,
// including a stale-sha 409/422, which the push re-reads before it counts as a failed attempt.
function writeFailure(status) {
  if (status === 401) return { kind: 'revoked' };
  if (status === 403 || status === 404) return { kind: 'noTarget' };
  return { kind: 'github', status };
}

// null failure means the file is on GitHub (a write, or the identical-content skip).
// 'retry' is the only action a caller may loop on. 'hold' must not run again until a new push or a new token.
function decide(failure, attempt) {
  if (!failure) return { action: 'clear' };
  if (isPermanentKind(failure.kind)) return { action: 'hold', revoked: failure.kind === 'revoked' };
  if (attempt < OUTBOX_ATTEMPTS) return { action: 'retry' };
  return { action: 'later' };
}

function pendingText(failure) {
  if (failure?.kind === 'github' && failure.status === 'network') return "Pending, will retry: couldn't reach GitHub.";
  if (failure?.kind === 'github' && failure.status != null) return `Pending, will retry: GitHub error ${failure.status}.`;
  return 'Pending, will retry.';
}

function sameFile(a, b) {
  return Boolean(a) && Boolean(b) && a.path === b.path && a.content === b.content;
}

function addItem(items, file) {
  const list = Array.isArray(items) ? items : [];
  if (!file || typeof file.path !== 'string' || typeof file.content !== 'string' || typeof file.message !== 'string') return list;
  if (list.some((item) => sameFile(item, file))) return list;
  return list.concat({ path: file.path, content: file.content, message: file.message, held: false });
}

function removeItem(items, file) {
  const list = Array.isArray(items) ? items : [];
  const index = list.findIndex((item) => sameFile(item, file));
  if (index === -1) return list;
  return list.slice(0, index).concat(list.slice(index + 1));
}

function markHeld(items, file, held) {
  const list = Array.isArray(items) ? items : [];
  const index = list.findIndex((item) => sameFile(item, file));
  const nextHeld = Boolean(held);
  if (index === -1 || Boolean(list[index].held) === nextHeld) return list;
  const next = list.slice();
  next[index] = { path: list[index].path, content: list[index].content, message: list[index].message, held: nextHeld };
  return next;
}

function itemKey(item) {
  return `${item.path}\0${item.content}`;
}

// `paused` is this wake's memory. A new worker has an empty set, so a non-held file is picked up again.
function nextItem(items, options) {
  const includeHeld = Boolean(options?.includeHeld);
  const paused = options?.paused;
  const list = Array.isArray(items) ? items : [];
  return list.find((item) => item && typeof item.path === 'string' && typeof item.content === 'string' &&
    !(paused && paused.has(itemKey(item))) && (includeHeld || !item.held)) ?? null;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    OUTBOX_ATTEMPTS, isPermanentKind, isShaConflict, writeFailure, decide, pendingText,
    sameFile, addItem, removeItem, markHeld, itemKey, nextItem,
  };
}
