## AC2Git

Push your Accepted LeetCode submissions to your `leetcode-submissions` GitHub repo.

Existing tools/extensions use GitHub OAuth with the `repo` scope: read/write on **every** repo, public and private. AC2Git uses a fine-grained token scoped to `leetcode-submissions` alone. No servers, no analytics, and solution code is never stored.

[Install from the Chrome Web Store](https://chromewebstore.google.com/detail/ac2git-leetcode-to-github/lhjleohalcomkbppbhnfolodkchgppef)

## What it touches

- **GitHub:** only `leetcode-submissions`, through a fine-grained token you create. It can't write to any other repo or read your private ones. To prove that, the token check sends read-only requests to your other repos, and GitHub refuses every one for a correct token.
- **LeetCode:** your own Accepted submission, read through LeetCode's API in your logged-in session.
- **Nothing else.** No servers, no analytics. The token stays in this browser and is only ever sent to `api.github.com`.

## How to Use

1. [Install from the Chrome Web Store](https://chromewebstore.google.com/detail/ac2git-leetcode-to-github/lhjleohalcomkbppbhnfolodkchgppef) and pin AC2Git.
2. Click the icon. It guides you through [Create the repo](https://github.com/new?name=leetcode-submissions) (click Create) and [Create the token](https://github.com/settings/personal-access-tokens/new?name=AC2Git&description=LeetCode+sync+to+one+repo&expires_in=none&contents=write) (Repository access: **Only select repositories** → `leetcode-submissions`, then Generate token).
3. Paste the token and click **Test & save**.
4. Submit on LeetCode.

An Accepted submission becomes one file, such as `0001-two-sum.py`, with commit message `1. Two Sum (Python3)`. Accepting again overwrites the file. Identical code makes no commit. The icon shows a green `OK` for 10 seconds when the file lands, and a red `!` when it does not. Click the icon to see why.

## Notes

- Needs Chrome 140+.
- Only **Submit** counts. **Run** does not.
- No badge at all? Reload the LeetCode tab once after installing or updating, then submit again.
- **Test & save** checks, read-only, that the token reaches `leetcode-submissions`, none of your other repos, and has no SSH-key permission. A token that fails is rejected and not saved. The same check runs before every push.
- What it can't detect: an **All repositories** token while `leetcode-submissions` is the only repo you own (the first push after you create a second repo catches it), and extra permissions beyond Contents: Read and write. The link presets the name, description, no expiration, and Contents: Read and write; GitHub also adds Metadata: Read-only. Leave those as they are.

## Development

1. `git clone https://github.com/PengLin-Zilv/AC2Git.git`
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick the cloned folder.
3. After code changes, click the reload button on the AC2Git card and reload LeetCode tabs.

Issues and pull requests welcome.

## License

MIT, see [LICENSE](LICENSE).
