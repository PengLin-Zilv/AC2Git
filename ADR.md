# AC2Git: decisions

Decisions and their reasons. A PR that contradicts one needs a new entry that supersedes it, in the same PR. Each entry is a decision that is hard to reverse, surprising without context, and the result of a real trade-off. Newest last. Don't edit history.

## Rules

Every change must keep these. Each one points to the entry that explains it.

- Manifest permissions stay at `storage` + host `api.github.com`. Any addition needs a new entry (0009).
- The token is read only in `background.js`. Content scripts get nothing derived from storage (0007, 0011).
- No network calls except same-origin `leetcode.com` (from `content.js`) and `api.github.com` (from `background.js`). User-clicked links that open a new tab are navigation, not requests (0011).
- The token check proves, with read-only GETs, that the token reaches the user's own `leetcode-submissions`, no other repo, and no SSH-key permission. It runs on save and before every push. Anything it can't prove is a rejection. No write request ever goes to any other repo (0002, 0003).
- No features beyond "Accepted code → one file in one repo". See the non-goals in 0009 and 0011.
- No dependencies, no build step. `node --test` must pass (0014).
- LeetCode has two fragile points: the `/submissions/detail/<id>/v2/check/` poll in `hook.js`, and the GraphQL `submissionDetails(submissionIdV2: ID!)` fields in `content.js`. When LeetCode changes, look there first (0005).

## 0001 · A fine-grained PAT limited to one repo, no OAuth (2026-10-23)

Existing tools use GitHub OAuth with the `repo` scope, which grants read/write on every repo. A fine-grained PAT is the only credential a user can create that writes to exactly one repo, needs no server, and is easy to revoke.

**Considered:**
- OAuth: it needs the `repo` scope or a backend.
- A GitHub App: it needs a server and an install flow.
- A classic PAT: its scopes are account-wide.

## 0002 · Prove the token's scope with collaborators probes, not by counting visible repos (2026-10-23)

**Status:** supersedes the original rule "Test must report the token can see exactly 1 repo".

For a fine-grained PAT, `/user/repos` lists every public repo the user is affiliated with, whatever the selection. A one-repo token listed dozens. So the count rejected correct tokens and proved nothing.

**The check now:**
- List the user's own repos. Reject any private repo other than the target.
- `GET /repos/{o}/{r}/collaborators` must be 200 on the target and refused on every other own repo.
- `/user/keys` must be refused.

This was measured live: 200 exactly when the repo is granted.

"Refused" has to be proven, not inferred. It means a 404, or a 403 whose `message` is exactly `Resource not accessible by personal access token`. Any other answer rejects the token. An earlier version counted every 403 that didn't look like a rate limit as refused, and the code review showed that an odd 403 on a granted repo let an over-scoped token pass.

**Considered:**
- Counting only private repos. It accepts an All-repositories token whenever the user's other repos are all public.
- A no-op `PATCH` ref probe. It is a write-method request to repos we must never touch.

**Consequences:**
- Read-only GETs reach the user's other repos and are refused. The maintainer accepted this as not "touching" them.
- Undetectable: an All-repositories token while `leetcode-submissions` is the only repo the user owns.

## 0003 · Re-run the scope check before every push (2026-10-23)

Community reports say editing a fine-grained token can silently reset it to All repositories. A check that runs only at save time would never notice.

**Cost:** three GETs plus one per other repo the user owns, about 1 s per push. A GitHub hiccup blocks that push, and resubmitting is the retry.

## 0004 · The target is fixed to the user's own `leetcode-submissions` (2026-10-23)

There are no owner/repo inputs, and the extension doesn't use "whichever repo the token grants". That rule would accept a token scoped to the wrong repo, for example the public `AC2Git` source repo, and commit into it. The owner comes from the token's user.

## 0005 · Detect Accepted by wrapping the page's fetch, then re-verify through GraphQL (2026-10-23)

`hook.js` runs in the page world and watches the page's own `/submissions/detail/<id>/v2/check/` poll. `content.js` re-reads the submission with `submissionDetails(submissionIdV2)` and pushes only when `statusCode === 10`.

The page message is only a hint. A forged one can trigger a lookup but can't push unverified code.

**Considered:**
- Scraping the DOM. It would add a third fragile dependency on LeetCode, after the `/v2/check/` poll and the GraphQL fields.
- Polling LeetCode from the extension. That means more traffic and more code.

## 0006 · Content scripts run on all of leetcode.com; GitHub is the hard line (2026-10-23)

LeetCode is one Next.js app. Opening a problem from the problem list doesn't load a `/problems/*` document, so the scripts would miss that submission. Chrome's install warning is per host, so the wider match adds no permission.

The hard line is GitHub: never touch any repo except `leetcode-submissions`. The breadth of the leetcode.com match matters much less.

## 0007 · Require Chrome 140 so token isolation is enforced (2026-10-23)

`chrome.storage.local.setAccessLevel('TRUSTED_CONTEXTS')` (Chrome 140) makes storage unreadable from content scripts. "The token is read only in `background.js`" is therefore enforced by the browser, not a convention. Chrome 140 also brings `Uint8Array.prototype.toBase64`, so there is no hand-rolled base64.

## 0008 · One flat file per problem and language; overwrite, skip identical (2026-10-23)

Each file is `NNNN-slug.ext` at the repo root and holds the submitted code byte for byte. The commit message is `<id>. <Title> (<Language>)`.

- Re-accepting a problem overwrites the file. Git history keeps the old versions.
- Identical code makes no commit, so a double-fired hook is harmless.
- **Trade-off:** the Python variants share `.py` and the SQL dialects share `.sql`, so the latest of those overwrites the others.

Changing the layout later means renaming every existing file.

## 0009 · Out of scope, on purpose (2026-10-23)

**Status:** partly superseded by 0011. Custom icons and the Chrome Web Store are now in scope. Everything else below still stands.

Each of these fails "Accepted code → one repo":
- leetcode.cn
- backfilling old submissions
- README, index or stats generation
- problem statements and notes
- runtime and memory stats
- retry queues
- options page
- multiple repos
- custom icons and the Chrome Web Store

Feedback is the toolbar badge only:
- In-page UI would couple to LeetCode's DOM.
- Desktop notifications need a new permission.

`chrome.storage.sync` is out because it would copy the token to Google sync and other devices.

## 0010 · The token field is `type="text"` with disc masking, not `type="password"` (2026-10-23)

Chrome's password manager keys on `type="password"` fields. If it offered to save the token, Google Password Manager sync could copy it off the machine, which is the same reason `chrome.storage.sync` is out. So the field is `type="text"` with `-webkit-text-security: disc`, `autocomplete="off"` (no Autofill history) and `spellcheck="false"` (no Enhanced spell check). It looks like a password field, but Chrome never treats it as one.

**What it gives up:**
- While the token is in the field, Ctrl+C or a drag copies the real value.
- Screen readers may read the token aloud, for example after a rejected save, when the value stays in the field focused and selected.
- These exposures are local and only to the user. The field is emptied after every successful save.

**Verify once in Chrome:**
- `chrome://password-manager/passwords` has no entry after a save. Confirmed 2026-10-23.
- No Autofill suggestions appear in the field.
Screen readers are out of scope by the maintainer's decision (2026-10-23), so the screen-reader cost above is accepted and won't be tested. Don't switch back to `type="password"` for that reason.

## 0011 · Publish on the Chrome Web Store and open-source the project (2026-10-30)

**Status:** supersedes the "custom icons and the Chrome Web Store" bullet of 0009.

The maintainer decided to publish AC2Git on the Chrome Web Store and to open-source it. That changes who arrives and what they know.

- **Users arrive from the store listing, not the README.** So the popup's no-token state now guides setup itself:
  - "Create the repo" (`github.com/new?name=leetcode-submissions`) and "Create the token" (the prefilled fine-grained form) open in a new tab
  - a 401 push failure shows the same token link
  - one sentence says what is uploaded and where the token goes

  This reverses the popup redesign's (`cbdd267`) rejection of first-run links, whose premise was "users arrive from the README". It shipped in PR #1 (`83b1f77`).
- **Links are navigation, not network.** User-clicked links to `github.com` that open a new tab are allowed. The extension still makes requests only to same-origin `leetcode.com` and `api.github.com`.
- **One token URL.** The popup and README token URLs must stay identical.
- **New work this brings in:**
  - icons (the toolbar icon must carry the green `OK` / red `!` badge)
  - a store listing
  - permission justifications and a single-purpose statement
  - a privacy policy
  - a LICENSE
  - governing docs that contributors can see. PR #1's first version, written by an agent that couldn't see the then-unpublished rules, collided with three recorded decisions.
- **Still out of scope:**
  - retry queues and storing solution code at rest. PR #1's outbox was dropped for this, see 0003.
  - content scripts receiving anything derived from storage (0007). PR #1's `status()` gate was dropped for this.
  - in-page UI on LeetCode
  - everything else in 0009

## 0012 · The token link sets no expiration (2026-10-30)

The token link in the README and the popup includes `expires_in=none`. GitHub documents it as valid ("1 to 366, or `none`"). Without it, GitHub's form defaults to 30 days, so every push fails with a 401 a month later, and rotation must mean making a new token, never editing one (0003).

**Trade-off:** the credential never expires. It is still limited to one repo with Contents: Read and write, re-checked before every push, and revocable on GitHub. README step 2 shows "Expiration: No expiration", so the choice is visible. It shipped in PR #1.

## 0013 · A successful save clears a stale token failure (2026-10-30)

**Status:** reverses the popup redesign's (`cbdd267`) choice to keep a red `!` after a good re-save.

After a push fails for a token reason, saving a token that passes the check removes `last` and resets the badge and title. The token reasons are `revoked`, `overScoped`, `noTarget` (the check couldn't reach the repo) and `noToken`. The popup then shows the saved state without a last result ("No pushes yet." and the reload hint). The missed submission still has to be resubmitted.

A write that returns 403 or 404 (`noWrite`) stays, because the check can't prove write access, so a new token may have the same problem.

**Why:** PR #1 added a "Create a new token" link under the 401 row, so a kept row told users to make the token they had just made. GitHub, network, LeetCode and "over 100 repos" failures stay, because a new token doesn't fix them.

**How:** `last` carries a `kind`. It reaches only the sender-checked popup, never a content script (0007).

## 0014 · Tests live in `test/`, run with `node --test` (2026-10-30)

The project is now open source, and its safety rests on the fail-closed token check (0002). The mock harnesses that guarded the check lived in temp folders and were lost twice. So tests are now in the repo, in `test/`: one file per script, using only built-in Node modules (`node:test`, `vm`), with no dependencies and no `package.json`.

`node --test` must pass before any change to `background.js`, `content.js`, `hook.js` or `popup.*`. This is a deliberate exception to "fewest files": the store zip ships only the extension files, so `test/` costs users nothing. That holds only if the zip is built from the commit with the files named:

```
git archive --format=zip -o ../ac2git-$(git describe --always).zip HEAD manifest.json background.js content.js hook.js popup.html popup.js
```

Add the icon files once they land. Zipping the folder would also ship `test/`, the docs, and the local `CLAUDE.md` and `CONTEXT.md`.
