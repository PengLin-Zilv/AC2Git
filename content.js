// Isolated world. Turns hook.js's "accepted" hint into a verified file for background.js.
// The hint carries only a submission id; everything pushed comes from LeetCode's own API.

const QUERY = `query ac2git($id: ID!) {
  submissionDetails(submissionIdV2: $id) {
    code
    statusCode
    lang { name verboseName }
    question { questionFrontendId title titleSlug }
  }
}`;
const ACCEPTED = 10;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const EXT = {
  cpp: 'cpp', java: 'java', python: 'py', python3: 'py', pythondata: 'py', c: 'c', csharp: 'cs',
  javascript: 'js', typescript: 'ts', php: 'php', swift: 'swift', kotlin: 'kt', dart: 'dart',
  golang: 'go', ruby: 'rb', scala: 'scala', rust: 'rs', racket: 'rkt', erlang: 'erl', elixir: 'ex',
  mysql: 'sql', mssql: 'sql', oraclesql: 'sql', postgresql: 'sql', bash: 'sh',
};

window.addEventListener('message', (e) => {
  const d = e.data;
  if (e.source !== window || e.origin !== location.origin) return;
  if (d?.source !== 'ac2git' || d.type !== 'accepted') return;
  if (typeof d.submissionId !== 'string' || !/^\d{1,20}$/.test(d.submissionId)) return;
  onAccepted(d.submissionId);
});

async function onAccepted(id) {
  try {
    const s = await judgedSubmission(id);
    if (s.statusCode === ACCEPTED) send({ type: 'push', ...toFile(s) }); // any other verdict: do nothing
  } catch {
    send({ type: 'leetcodeError' });
  }
}

// Retries "still judging" (LeetCode's own client shows a null or 0 statusCode as "Judging...") and
// transient failures (network, 429/5xx, bad JSON). Resubmitting instead would cost a new submission.
async function judgedSubmission(id) {
  for (let attempt = 1; ; attempt++) {
    const s = await querySubmission(id).catch(() => null);
    if (s?.statusCode) return s;
    if (attempt === 3) throw new Error('no judged submission from LeetCode');
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

// Same-origin, so the default credentials send the session cookie, as LeetCode's own client does.
async function querySubmission(id) {
  const csrf = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]*)/)?.[1] ?? '';
  const r = await fetch('https://leetcode.com/graphql/', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrftoken': csrf },
    body: JSON.stringify({ query: QUERY, variables: { id } }),
  });
  if (!r.ok) throw new Error(`LeetCode GraphQL ${r.status}`);
  return (await r.json()).data?.submissionDetails;
}

function toFile({ code, lang, question }) {
  const { name, verboseName } = lang ?? {};
  const { questionFrontendId: num, title, titleSlug: slug } = question ?? {};
  const allStrings = [code, name, verboseName, num, title, slug].every((v) => typeof v === 'string');
  if (!allStrings || !/^\d+$/.test(num) || !SLUG.test(slug)) throw new Error('unexpected submission shape');
  const ext = Object.hasOwn(EXT, name) ? EXT[name] : 'txt'; // hasOwn: "constructor" must not hit Object.prototype
  return {
    path: `${num.padStart(4, '0')}-${slug}.${ext}`,
    content: code,
    message: `${num}. ${title} (${verboseName})`,
  };
}

// background.js never replies to these, and sending throws once the extension is reloaded
// under an open tab. Neither is something this tab can act on.
function send(msg) {
  try {
    chrome.runtime.sendMessage(msg).catch(() => {});
  } catch {}
}
