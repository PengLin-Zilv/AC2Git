// Hands a pasted token to background.js and shows its replies. Never touches storage.
const [statusEl, form, input, msg] = ['status', 'form', 'token', 'msg'].map((id) => document.getElementById(id));
const button = form.querySelector('button');
const NO_REPLY = { ok: false, text: 'Not saved: something went wrong. Try again.' }; // rejected, or an empty reply
let saved = false; // a token is saved, per the last status reply

function el(tag, cls, ...kids) {
  const node = document.createElement(tag);
  node.className = cls;
  node.append(...kids); // strings become text nodes: replies are never parsed as HTML
  return node;
}

// Literals render as unbroken mono: a repo, a file, leetcode-submissions, github_pat_. A miss is plain text.
const LITERAL = /([\w.-]+\/[\w.-]*\w|\d{4,}-[\w-]+\.\w+|leetcode-submissions|github_pat_)/;
const rich = (text) => text.split(LITERAL).map((s, i) => (i % 2 ? el('code', s.length > 40 ? 'long' : '', s) : s));

// Today: the time. Earlier: the date, plus the year if it isn't this one, so an old result never passes as
// today's. Both follow the browser's locale.
const when = (d, now = new Date()) => (d.toDateString() === now.toDateString()
  ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  : d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' }));

// One row: dot (none: hollow | ok | err | info: no dot, muted text) · text, the time floated right, an optional muted hint.
function row(dot, text, at, hint) {
  const body = el('span', 'body', ...rich(text));
  if (at) body.prepend(Object.assign(el('time', '', when(new Date(at))), { title: new Date(at).toLocaleString() }));
  if (hint) body.append(el('span', 'hint', ...rich(hint)));
  return el('p', 'row', Object.assign(el('span', `dot ${dot}`), { ariaHidden: 'true' }), body);
}

// status reply → {repo, last}; {text} or nothing → the popup couldn't load it, so it claims neither token state.
function showStatus(reply) {
  const failed = !reply || 'text' in reply;
  saved = !failed && Boolean(reply.repo);
  const rows = [];
  if (failed) rows.push(row('none', "Couldn't load status. Reopen AC2Git to try again."));
  else {
    if (saved) rows.push(el('p', 'repo', 'Pushes to ', ...rich(reply.repo)));
    if (reply.last) rows.push(row(reply.last.ok ? 'ok' : 'err', reply.last.text, reply.last.at));
    else if (saved) rows.push(row('none', 'No pushes yet.', 0, 'Reload LeetCode tabs, then Submit (not Run).'));
    else rows.push(row('none', 'No token saved.', 0, 'Paste a fine-grained token limited to leetcode-submissions.'));
  }
  statusEl.replaceChildren(...rows);
  document.body.classList.toggle('no-token', !failed && !saved); // fills the button; unknown counts as neither
  input.placeholder = saved ? 'Paste a new token to replace it' : 'github_pat_…';
  input.ariaLabel = saved ? 'Replace token' : 'Fine-grained token';
  if (!failed && !saved) input.focus(); // focus follows purpose: only when there's no token yet
}

const refresh = () => chrome.runtime.sendMessage({ type: 'status' }).catch(() => undefined).then(showStatus);
const busy = (on) => { form.ariaBusy = String(on); input.readOnly = button.disabled = on; }; // disabled also blocks Enter
const say = (kind, text, hint) => msg.replaceChildren(row(kind, text, 0, hint));

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  input.focus(); // every result belongs to the field
  if (!input.value.trim()) return say('info', 'Paste a token first.');
  busy(true);
  say('info', 'Checking with read-only GitHub requests…');
  const reply = await chrome.runtime.sendMessage({ type: 'save', token: input.value }).then((r) => r ?? NO_REPLY, () => NO_REPLY);
  busy(false);
  if (reply.ok) {
    input.value = ''; // the token is never shown once saved, not even masked
    say('ok', reply.text);
    refresh();
  } else {
    // Only background.js's own answer proves the saved token was kept; without one it's unknown.
    say('err', reply.text, saved && reply !== NO_REPLY ? 'Your saved token was kept.' : '');
    input.select(); // a paste replaces it, Enter retries
  }
});
input.addEventListener('input', () => msg.replaceChildren()); // a result is stale once the field changes
refresh();
