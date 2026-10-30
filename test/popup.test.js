// popup.js against a tiny fake DOM and a stubbed chrome.runtime, plus static checks of popup.html's setup steps.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const JS = fs.readFileSync(path.join(ROOT, 'popup.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'popup.html'), 'utf8');
const TOKEN = 'github_pat_11ABCDEFG0123456789_abcdefghij';
const REPO = 'me/leetcode-submissions';
// popup.js has no timers and the stub answers at once, so draining promise reactions is exact; no fixed sleep.
const settle = () => new Promise(setImmediate);

class Text {
  constructor(text) { this.textContent = String(text); }
  cloneNode() { return new Text(this.textContent); }
}
class El {
  constructor(tag, attrs = {}) { Object.assign(this, { tag, attrs: { ...attrs }, children: [], listeners: {}, value: '' }); }
  get id() { return this.attrs.id; }
  get className() { return this.attrs.class ?? ''; }
  set className(v) { this.attrs.class = v; }
  get classList() {
    const set = new Set(this.className.split(' ').filter(Boolean));
    return { contains: (c) => set.has(c), toggle: (c, on) => { on ? set.add(c) : set.delete(c); this.className = [...set].join(' '); } };
  }
  get textContent() { return this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { this.children = [new Text(v)]; }
  append(...kids) { this.children.push(...kids.map((k) => (typeof k === 'string' ? new Text(k) : k))); }
  prepend(...kids) { this.children.unshift(...kids.map((k) => (typeof k === 'string' ? new Text(k) : k))); }
  replaceChildren(...kids) { this.children = []; this.append(...kids); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  removeAttribute(k) { delete this.attrs[k]; }
  cloneNode() { const n = new El(this.tag, this.attrs); n.children = this.children.map((c) => c.cloneNode()); return n; }
  addEventListener(type, f) { this.listeners[type] = f; }
  querySelector(tag) { return this.find((n) => n.tag === tag); }
  find(pred) { return pred(this) ? this : this.children.reduce((hit, c) => hit ?? c.find?.(pred) ?? null, null); }
  all(pred, out = []) { if (pred(this)) out.push(this); this.children.forEach((c) => c.all?.(pred, out)); return out; }
  focus() { doc.activeElement = this; }
  select() { this.selected = true; }
}

let doc;
// statuses: replies to successive status calls; save: a reply, 'pending' or 'reject'. Error or 'reject' = rejected call.
function popup({ statuses = [{ repo: null, last: null }], save } = {}) {
  const sent = [];
  const answer = (r) => (r === 'reject' ? Promise.reject(new Error('port closed')) : r === 'pending' ? new Promise(() => {}) : Promise.resolve(r));
  const [, href, rest] = /<a id="token-link" href="([^"]+)"([^>]*)>/.exec(HTML);
  const link = new El('a', { id: 'token-link', href: href.replaceAll('&amp;', '&'), ...Object.fromEntries([...rest.matchAll(/(\w+)="([^"]*)"/g)].map((m) => m.slice(1))) });
  link.textContent = 'Create the token';
  const form = new El('form', { id: 'form' });
  const els = { status: new El('section', { id: 'status' }), form, token: new El('input', { id: 'token', 'aria-describedby': 'status msg' }), msg: new El('div', { id: 'msg' }), 'token-link': link };
  form.append(els.token, new El('button'));
  const body = new El('body');
  body.append(els.status, link, form);
  doc = { body, activeElement: body, getElementById: (id) => els[id] ?? null, createElement: (tag) => new El(tag) };
  const chrome = { runtime: { sendMessage: (m) => { sent.push(structuredClone(m)); return answer(m.type === 'status' ? statuses[Math.min(sent.filter((s) => s.type === 'status').length - 1, statuses.length - 1)] : save); } } };
  vm.runInContext(JS, vm.createContext({ document: doc, chrome }));
  const submit = async (value) => { els.token.value = value; els.form.listeners.submit({ preventDefault() {} }); await settle(); };
  return { els, body, sent, submit, link, button: form.querySelector('button') };
}
const noTokenIn = (p) => assert.ok(!p.body.all((n) => JSON.stringify(n.attrs).includes(TOKEN) || n.children.some((c) => c instanceof Text && c.textContent.includes(TOKEN))).length);

test('first run: no-token state shows the setup, names the disclosure, focuses the field', async () => {
  const p = popup();
  await settle();
  assert.equal(p.els.status.textContent, 'No token saved.');
  assert.ok(p.body.classList.contains('no-token'));
  assert.equal(p.els.token.getAttribute('aria-describedby'), 'status disclosure msg');
  assert.equal(p.els.token.placeholder, 'github_pat_…');
  assert.equal(doc.activeElement, p.els.token);
});

test('popup.html: the setup steps are shown only in the no-token state and link where they should', () => {
  assert.match(HTML, /\.setup \{ display: none; \}/);
  assert.match(HTML, /body\.no-token \.setup \{ display: block; \}/);
  const links = [...HTML.matchAll(/<a ([^>]+)>([^<]+)<\/a>/g)].map(([, attrs, text]) => ({ attrs, text }));
  assert.deepEqual(links.map((l) => l.text), ['Create the repo', 'Create the token']);
  assert.match(links[0].attrs, /href="https:\/\/github\.com\/new\?name=leetcode-submissions"/);
  assert.match(links[1].attrs, /href="https:\/\/github\.com\/settings\/personal-access-tokens\/new\?[^"]*expires_in=none&amp;contents=write"/);
  for (const l of links) assert.match(l.attrs, /target="_blank" rel="noopener noreferrer"/);
  assert.match(HTML, /Only select repositories → <code>leetcode-submissions<\/code>/);
  assert.match(HTML, /<p id="disclosure" class="setup disclosure">[^<]*<code>leetcode-submissions<\/code>[^<]*sent only to api\.github\.com\.<\/p>/);
});

test('saved, no pushes yet: repo line, reload hint, setup hidden, field not focused', async () => {
  const p = popup({ statuses: [{ repo: REPO, last: null }] });
  await settle();
  assert.equal(p.els.status.textContent, `Pushes to ${REPO}No pushes yet.Reload LeetCode tabs, then Submit (not Run).`);
  assert.ok(!p.body.classList.contains('no-token'));
  assert.equal(p.els.token.getAttribute('aria-describedby'), 'status msg');
  assert.equal(p.els.token.placeholder, 'Paste a new token to replace it');
  assert.equal(p.els.token.ariaLabel, 'Replace token');
  assert.notEqual(doc.activeElement, p.els.token);
});

test('last push OK: green dot and a time', async () => {
  const p = popup({ statuses: [{ repo: REPO, last: { ok: true, text: 'OK 0001-two-sum.py', at: Date.now() } }] });
  await settle();
  assert.ok(p.els.status.find((n) => n.className === 'dot ok'));
  assert.ok(p.els.status.find((n) => n.tag === 'time'));
  assert.ok(p.els.status.textContent.endsWith('OK 0001-two-sum.py'));
});

test('a revoked token push links "Create a new token" to the setup token page', async () => {
  const text = 'Not pushed: GitHub rejected the token (expired or revoked). Paste a new one in AC2Git, then submit again.';
  const p = popup({ statuses: [{ repo: REPO, last: { ok: false, text, at: Date.now(), kind: 'revoked' } }] });
  await settle();
  const a = p.els.status.find((n) => n.tag === 'a');
  assert.equal(a.textContent, 'Create a new token');
  assert.equal(a.getAttribute('href'), p.link.getAttribute('href'));
  assert.equal(a.getAttribute('id'), null); // a clone, not a second #token-link
  assert.equal(a.getAttribute('rel'), 'noopener noreferrer');
});

test('no link for any other result', async () => {
  for (const last of [
    { ok: false, text: 'Not pushed: GitHub error 500. Submit again.', kind: 'github' },
    { ok: false, text: "Not pushed: can't write to leetcode-submissions. …", kind: 'noTarget' },
    { ok: true, text: 'OK 0001-two-sum.py' },
  ]) {
    const p = popup({ statuses: [{ repo: REPO, last: { ...last, at: Date.now() } }] });
    await settle();
    assert.equal(p.els.status.find((n) => n.tag === 'a'), null, last.text);
  }
});

test('status failed (rejected, empty or an error text): claims neither token state', async () => {
  for (const reply of ['reject', undefined, { ok: false, text: 'Not saved: something went wrong. Try again.' }]) {
    const p = popup({ statuses: [reply] });
    await settle();
    assert.equal(p.els.status.textContent, "Couldn't load status. Reopen AC2Git to try again.");
    assert.ok(!p.body.classList.contains('no-token'));
    assert.notEqual(doc.activeElement, p.els.token);
  }
});

test('empty submit asks for a token and sends nothing', async () => {
  const p = popup();
  await p.submit('   ');
  assert.equal(p.els.msg.textContent, 'Paste a token first.');
  assert.deepEqual(p.sent.map((m) => m.type), ['status']);
});

test('while the check runs: read-only field, disabled button, aria-busy, progress text', async () => {
  const p = popup({ save: 'pending' });
  await p.submit(TOKEN);
  assert.equal(p.els.token.readOnly, true);
  assert.equal(p.button.disabled, true);
  assert.equal(p.els.form.ariaBusy, 'true');
  assert.equal(p.els.msg.textContent, 'Checking with read-only GitHub requests…');
});

test('save passed: field emptied, result shown, status re-read (stale failure gone), token nowhere in the DOM', async () => {
  const text = 'Saved. Reaches leetcode-submissions and none of your other repos (3 checked).';
  const p = popup({ statuses: [{ repo: REPO, last: { ok: false, text: 'Not pushed: …', at: 1, kind: 'revoked' } }, { repo: REPO, last: null }], save: { ok: true, text } });
  await settle();
  await p.submit(TOKEN);
  assert.equal(p.els.token.value, '');
  assert.equal(p.els.msg.textContent, text);
  assert.deepEqual(p.sent.map((m) => m.type), ['status', 'save', 'status']);
  assert.equal(p.sent[1].token, TOKEN);
  assert.ok(p.els.status.textContent.includes('No pushes yet.'));
  assert.equal(p.els.status.find((n) => n.tag === 'a'), null);
  assert.equal(p.els.token.readOnly, false);
  noTokenIn(p);
});

test('save rejected with a token saved: value kept and selected, "kept" hint, token not in any text', async () => {
  const text = 'Not saved: this token also reaches me/AC2Git. Delete it on GitHub and use one with Only select repositories → leetcode-submissions.';
  const p = popup({ statuses: [{ repo: REPO, last: null }], save: { ok: false, text } });
  await settle();
  await p.submit(TOKEN);
  assert.equal(p.els.token.value, TOKEN);
  assert.equal(p.els.token.selected, true);
  assert.equal(p.els.msg.textContent, `${text}Your saved token was kept.`);
  noTokenIn(p);
});

test('no reply or an empty reply: generic failure, no "kept" claim, not stuck busy', async () => {
  for (const save of ['reject', undefined]) {
    const p = popup({ statuses: [{ repo: REPO, last: null }], save });
    await settle();
    await p.submit(TOKEN);
    assert.equal(p.els.msg.textContent, 'Not saved: something went wrong. Try again.');
    assert.equal(p.button.disabled, false);
  }
});

test('typing clears a stale result; replies stay text, never HTML', async () => {
  const p = popup({ statuses: [{ repo: REPO, last: { ok: false, text: '<img src=x onerror=alert(1)>', at: Date.now() } }] });
  await settle();
  assert.equal(p.els.status.find((n) => n.tag === 'img'), null);
  assert.ok(p.els.status.textContent.endsWith('<img src=x onerror=alert(1)>'));
  await p.submit('');
  p.els.token.listeners.input();
  assert.equal(p.els.msg.textContent, '');
});
