## AC2Git

Push your Accepted LeetCode submissions to your `leetcode-submissions` GitHub repo.

Existing tools/extensions use GitHub OAuth with the `repo` scope: read/write on **every** repo, public and private.
The real need is to write one file into one repo, so AC2Git's token can do exactly that and nothing more.

## What it touches

- **GitHub:** only `leetcode-submissions`, through a fine-grained token you create. It can't write to any other repo or read your private ones. To prove that, the token check sends read-only requests to your other repos, and GitHub refuses every one for a correct token.
- **LeetCode:** your own Accepted submission, read through LeetCode's API in your logged-in session.
- **Nothing else.** No servers, no analytics. The token is only ever sent to `api.github.com`.

## How to Use

1. Create a GitHub repo named `leetcode-submissions` (public or private).
2. [Create a fine-grained token](https://github.com/settings/personal-access-tokens/new?name=AC2Git&contents=write):
   - Resource owner: **you**
   - Repository access: **Only select repositories** → `leetcode-submissions`
   - Permissions: **Contents: Read and write** (GitHub adds Metadata: Read-only)
   - Account permissions: none
3. `git clone https://github.com/PengLin-Zilv/AC2Git.git`, open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick the folder. Pin the AC2Git icon. Needs Chrome 140+.
4. Click the icon, paste the token, and click **Test & save**. AC2Git checks, read-only, that the token reaches `leetcode-submissions`, none of your other repos, and has no SSH-key permission. A token that fails is rejected and not saved. The same check runs before every push.
   What it can't detect: an **All repositories** token while `leetcode-submissions` is the only repo you own (the first push after you create a second repo catches it), and extra permissions beyond step 2. Grant only what step 2 lists.
5. Submit on LeetCode as usual. Only **Submit** will count, **Run** doesn't.

When a submission is Accepted:

- File: `0001-two-sum.py`
- Commit: `1. Two Sum (Python3)`
- Accepted again: the file is overwritten. Identical code makes no commit.

The icon shows a green `OK` when the code lands and a red `!` when it doesn't. Click the icon to see why.

No badge at all? Reload the LeetCode tab (needed once after installing or updating) and submit again.
