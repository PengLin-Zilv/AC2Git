# AC2Git

Push Accepted LeetCode submissions to the user's `leetcode-submissions` GitHub repo. Nothing else.

## Why this exists

Existing tools (LeetHub etc.) use GitHub OAuth with the `repo` scope: read/write on **every** repo, public and private.
The real need is to write one file into one repo. So the permission should be exactly that.

## Principles

1. **First principles.** Start from the actual need (Accepted code -> one repo), not from what existing tools do. Every line must trace back to that need. If it can't, delete it.
2. **Minimal.** Fewest files, fewest permissions. No dependencies, no build step, no framework. Prefer deleting over adding.
3. **Least privilege.** The hard line is GitHub: never touch any repo except `leetcode-submissions`, public or private. Auth is a fine-grained PAT limited to that repo with Contents: read/write. No OAuth, no classic PAT, no `repo` scope. On LeetCode, scripts may run anywhere on `leetcode.com`; `hook.js` acts only on submission check responses.

## Flow

`hook.js` detects Accepted -> `content.js` verifies via LeetCode GraphQL -> `background.js` PUTs the file to GitHub. `popup.*` only stores token/owner/repo.

## Rules

- Manifest permissions stay at `storage` + host `api.github.com`. Any addition needs a stated reason.
- The token is read only in `background.js`. Never in a content script or the page world.
- No network calls except same-origin `leetcode.com` and `api.github.com`. No servers, analytics, or remote code.
- No new features (README generation, stats, other platforms) unless asked.
- Popup **Test** must report the token can see exactly 1 repo.

## When LeetCode changes

Two fragile points: the `/submissions/detail/<id>/v2/check/` poll (and its `ai_state` phase) in `hook.js`, and the GraphQL `submissionDetails(submissionIdV2: ID!)` fields in `content.js`.