# AC2Git privacy policy

Effective: October 30, 2026

AC2Git copies your Accepted LeetCode submissions into your own `leetcode-submissions` GitHub repo. It runs entirely in your browser. It has no server, and its developer receives none of your data.

## What it reads

- **LeetCode:** your own Accepted submission. To detect it, AC2Git watches the submission result that LeetCode's page already fetches. It then asks LeetCode's API, in your logged-in session, for that submission's code, language, problem number, title and slug. To make that request the way LeetCode's own page does, it uses LeetCode's `csrftoken` cookie. It reads nothing else from LeetCode.
- **GitHub, with your token:** before saving the token and before every push, AC2Git sends read-only requests to check that the token reaches only your `leetcode-submissions` repo. It lists the repos you own, asks GitHub whether the token can reach each one, and checks that the token has no SSH-key permission. Before writing, it reads the current version of the file it is about to write.

## What is sent where

- **Your code** goes only to your `leetcode-submissions` repo, through `api.github.com`. Each push is one file, such as `0001-two-sum.py`, with a commit message such as `1. Two Sum (Python3)`.
- **Your token** goes only to `api.github.com`.
- Nothing is sent anywhere else. The setup links in the popup open `github.com` pages in a new tab only when you click them.

## What is stored on your device

AC2Git keeps four items in `chrome.storage.local` on this device:

- your token
- your GitHub username (the repo owner)
- the repo name
- the result of the last push: its text, time, whether it succeeded, and for token or GitHub failures, the kind of failure

Chrome keeps this storage out of reach of web pages, including LeetCode, and doesn't sync it to your Google account. **Your solution code is never stored.** It passes through the extension's memory only on its way to GitHub.

## What is never collected

- no analytics or telemetry
- no servers of its own
- no sharing with third parties
- no remote code

The only services AC2Git contacts are LeetCode and GitHub, the two you already use. Their own privacy policies cover what they receive.

AC2Git's use of user data complies with the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq), including the Limited Use requirements.

## How to delete everything

- **Remove the extension** in `chrome://extensions`. Chrome deletes its stored data, including the token.
- **Revoke the token** at [github.com/settings/personal-access-tokens](https://github.com/settings/personal-access-tokens).

Code already pushed to your `leetcode-submissions` repo stays there until you delete it. It is your repo.

## Contact

Open an issue at [github.com/PengLin-Zilv/AC2Git/issues](https://github.com/PengLin-Zilv/AC2Git/issues).
