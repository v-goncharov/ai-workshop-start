---
name: status-update
description: Post a status update to Slack — the PRs merged and the issues resolved in this repository since a given time and date — in the private channel #very-secrect-alpaca-channel, with SLACK_BOT_TOKEN. Use when asked for a status update, a changelog or "what got done since …", and from the scheduled status-update automation.
---

# Status update

Post one Slack message: what was merged and resolved in this repository between a start time and now. Read-only on the repository: no branch, no commit, no PR.

## 1. The start
- The user gave a time or date ("since Monday 9:00", "since 2026-11-20"): turn it into ISO 8601 with an offset or `Z`, in the user's time zone if they named one, else UTC. A bare date means 00:00 that day.
- None given (the automation): leave it out. The script then starts where the last status update in the channel ended, or 24 hours ago if there is none. Don't pick a start yourself: that is what keeps a scheduled run from repeating or skipping work.

## 2. The draft
```bash
node .agents/skills/status-update/status-update.ts draft [<since>]
```
It prints the message in Slack mrkdwn: a first line `*Status update* <from> → <to>` (Slack shows the times in each reader's zone), the merged PRs (link, title, author, the issues each one closes), and the issues closed as completed. Issues closed as not planned or duplicate are left out. Exit 1 is an error (gh not logged in, Slack token missing, a bad time): report it and stop.

## 3. Polish
Under the first line, add one or two plain sentences on what the window was about, read from the titles (for example "The alpaca got a voice, and the skill map shipped."). Say nothing that the list doesn't show; if unsure, skip it. Keep everything else as the script wrote it:
- the first line, unchanged: the next run reads its end time from it;
- every PR and issue, in order; don't drop or merge items;
- Slack syntax: `<url|text>` links, `*bold*`, `•` bullets, not Markdown `**` or `[text](url)`.

"Nothing merged or resolved." still gets posted: it moves the window on, and silence would look like the automation broke.

## 4. Post
Pass the text on stdin through a quoted heredoc, so backticks and `$` in titles reach Slack as written:
```bash
node .agents/skills/status-update/status-update.ts post - <<'EOF'
<message>
EOF
```
It posts to `C0CM9AWDGVB` (#very-secrect-alpaca-channel; the token has no `channels:read`, so the channel is given by ID) and prints `posted: <ts>`. It refuses a message whose first line isn't the draft's. Post once: if it fails, report the error rather than retrying blindly, since a retried post can land twice.

## 5. Report
Tell the user the window, the counts, and the `posted:` line. If anything failed, say what and where it stopped.
