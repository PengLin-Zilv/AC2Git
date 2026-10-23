// Hands a pasted token to background.js and shows one status line. Never touches storage.
const line = document.getElementById('status');
const input = document.getElementById('token');

const hhmm = (t) => new Date(t).toTimeString().slice(0, 5);

function describe({ repo, last }) {
  const parts = [repo ? `Connected to ${repo}` : 'Not connected'];
  if (last) parts.push(`Last: ${last.text} ${hhmm(last.at)}`);
  return parts.join(' · ');
}

document.getElementById('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  line.textContent = 'Testing…';
  const { ok, text } = await chrome.runtime.sendMessage({ type: 'save', token: input.value });
  line.textContent = text;
  if (ok) input.value = ''; // the token is never shown once saved, not even masked
});

// A failed status reply carries only text.
chrome.runtime.sendMessage({ type: 'status' }).then((reply) => {
  line.textContent = reply.text ?? describe(reply);
});
