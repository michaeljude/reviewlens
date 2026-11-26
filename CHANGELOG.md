# Changelog

## 0.3.0 (preview)

- **Review rules and skills:** add your team's rules (`.reviewlens/rules/*.md`) and review playbooks (`.reviewlens/skills/<name>/SKILL.md`, the same format as Claude Code and Cursor skills) to the repository, or personal one-line rules in settings. Rules can target files with `globs` and carry a `severity`.
- The AI checks each file against the rules that apply to it and reports each break as a finding with a level and line. Findings show as **⚑** in the list and in a **Review rules** card in the file's review, and raise the file's risk.
- Changing a rule asks for a new AI review only of the files it covers; other saved results are kept.
- Rules are read from your local working tree, never from the pull or merge request under review.
- New commands: **Review rules and skills**, **New review rule**, **New review skill**. New settings: `reviewLens.useRules`, `reviewLens.personalRules`.
- The `/review-changes` and `/review-pr` plugin skills also follow `.reviewlens/` rules and skills.
- Fixed: with the Cursor agent backend, a review in a folder the agent hadn't been trusted in failed with the agent's own prompt text. ReviewLens now explains it and offers **Open in terminal** to trust the folder.
- Fixed: a file's review in local changes showed a stray "null" under its buttons.

## 0.2.0 (preview)

- **Comments in the editor, as on GitHub and GitLab:** a file's review shows the PR's comment threads under the lines they're on, with line numbers on the diff. Click **+** next to a line to comment; reply to threads and resolve or reopen them. Everything posts to GitHub or GitLab.
- **Post your review:** **Approve**, **Request changes** or **Comment** on the pull or merge request from the panel, optionally with a file-by-file summary of your approvals, after you confirm. The panel shows each reviewer's state.
- **Notifications on Refresh:** **Refresh** gets the latest comments, reviews and commits, and tells you about new review requests and about others' comments, approvals and change requests on your own PRs. Unread counts show on the panel icon, the status bar and the list. Nothing is checked in the background. New setting: `reviewLens.notifications.enabled`. New command: **Check for review activity now**.
- When new commits are pushed, Refresh updates the file list and keeps approvals on files that didn't change.
- **Cursor plugin:** the repository is now also an Agent Plugins plugin (`plugin.json`, `skills/`, `commands/`, `rules/`) with `/review-changes` and `/review-pr` commands, matching skills, and a rule that makes the agent summarise multi-file changes for review.
- Posting needs write access: GitHub tokens need Pull requests read and write; GitLab tokens need the `api` scope. A clear message offers a new token when the current one can only read.

## 0.1.0 (preview)

- New **Pull requests / Merge requests** tab: review open GitHub pull requests and GitLab merge requests (including self-hosted GitLab), with the ones waiting for your review listed first.
- Sign in with the editor's GitHub account or a personal access token; GitLab uses a token with the `read_api` scope. Tokens are kept in the editor's secure storage.
- PR files use the same area lanes, change types, on-demand AI review, saved results and per-file approvals as local changes. The AI also reads the PR's title and description.
- Teammates' review comments show on each file, with links to open them on GitHub or GitLab.
- New commands: Show pull / merge requests, Sign in, Use a personal access token, Remove saved access token. New setting: `reviewLens.gitlabHosts`.

## 0.0.2 (preview)

- Renamed to **ReviewLens**. Commands and settings now start with `reviewLens.` (for example `reviewLens.backend`).
- Fixed: opening the extension's settings froze Cursor. Settings now open as a quick menu inside the editor that shows each setting's current value and lets you change it, including areas.
- Clearer error when an AI CLI fails, with a sign-in hint when its login has expired.

## 0.0.1 (preview)

First release.

- ReviewLens panel listing uncommitted changes (staged, unstaged and new files).
- Group by area (configurable path prefixes) or by change type; obvious files are categorised by path rules without AI.
- Warning when code that changes behaviour changed but no tests did.
- **Run AI review** on demand only. Results are saved per file version, so unchanged files are never sent again. Asks before large reviews.
- AI backends: GitHub Copilot (VS Code), Cursor agent CLI and Claude Code CLI. Auto-detect picks Copilot in VS Code and the Cursor agent in Cursor.
- File detail view: why it changed, what changed, possible impact with risk, and the diff.
- Per-file **Approve** / **Request changes**, a checkbox in the list, and an approved count in the status bar. Approval clears when the file changes.
