# AI Change Reviewer

A VS Code / Cursor extension concept for reviewing AI-written code: it explains **why** each file changed, **what** changed, and **what it might affect**, so a human can understand and approve a large change quickly.

> Status: concept and UI mockups. No extension code yet.

## The problem

- AI agents change many files at once, usually with no description.
- Reading a pile of AI review comments is tiring, and comments don't tell you the intent.
- In a monorepo, one PR can mix mobile, backend and shared code. Reviewing it all together is hard; splitting it into several PRs is a hassle.

## What it does

### 1. Local review (unstaged changes)
- Lists changed files, grouped by **area** (Mobile / Backend / Shared) or by **change type** (UI, business logic, API, shared types, database, unit tests, infra, CI/CD, automation).
- Flags gaps, for example "behaviour changed but no tests were added".
- For each file: **why it changed**, **what changed**, **possible impact** (rated high / medium / low), the **key lines** of the diff, and the code that depends on it.
- Cross-area alerts when a shared contract (a type, an endpoint) changes in a way that affects other areas.
- **Per-file approval**: a checkbox on every file, plus *Approve file* and *Request changes*. Approval resets when the file changes.
- **Free edit**: change the code right in the review and save it to the working file.
- Optional **proof for reviewers**: attach a screen recording or screenshot before pushing.

### 2. PR / MR review (GitHub and GitLab)
- Generates a description when the PR has none.
- **Review lanes**: one PR split into Shared, Backend and Mobile lanes, each with its owner (from CODEOWNERS) and its own progress.
- **Cross-lane contracts**: where one lane depends on another (for example, backend defines an endpoint that mobile calls).
- **Teammate comments synced from the MR/PR**: jump to the code, apply a suggested change, reply and resolve without leaving the editor.
- AI-drafted review comments that are only posted when you choose.
- Proof attachments (recordings and screenshots) added to the PR description.

## When AI runs: trigger-only

To keep token costs down, AI only runs when you ask:

- A **Run AI review** button in the panel, and a command-palette command.
- Optional triggers, all **off by default**: before commit, when an AI agent session ends, on save of an already-reviewed file.

Things that never use AI: the file list, area grouping, rule-based categories (tests, CI files, migrations), finding dependents (VS Code's find-references), and approvals.

Token saving:
- Results are saved per file version; only files that changed since the last run are sent again.
- Only changed sections plus a little context are sent, never whole files.
- All files go in one request per review.
- Ask before a run larger than a set size.

## Connecting to AI

The extension builds one **review packet** (changed sections, context, categories) and sends it to a backend through a small adapter. The backend returns a fixed JSON format (why / what / impact / risk per file), which the extension checks before showing.

| Backend | How | Notes |
|---|---|---|
| GitHub Copilot | VS Code Language Model API (`vscode.lm.selectChatModels`) | No API key; uses the user's Copilot plan. Not available in Cursor. |
| Cursor agent | Cursor CLI in print mode (`agent -p --output-format json`) | Uses the user's Cursor plan. Admins can disable print mode. |
| Claude Code | `claude -p --output-format json` | Uses the user's Claude plan. |
| Codex | OpenAI Codex CLI (`codex exec`) | Uses the user's OpenAI plan. |
| Own API key | Anthropic or OpenAI SDK | Pay per token. Key stored in VS Code secret storage. |
| Chat tools (MCP) | Extension exposes `get_review_packet` and `submit_review` | Lets Cursor, Claude Code or Copilot agent mode run the review from chat. In Cursor, registered with `cursor.mcp.registerServer`. |

*Auto-detect* picks Copilot in VS Code and the Cursor agent in Cursor.

## Existing tools

Parts of this already exist:

- AI review of uncommitted changes: CodeRabbit, Qodo, Bito, GitHub Copilot (Source Control view).
- AI PR review: CodeRabbit, Qodo, Greptile, Graphite, Copilot code review, GitLab Duo.
- PR/MR comments inside VS Code: the GitHub Pull Requests and GitLab Workflow extensions.

What this concept focuses on instead of bug-finding: explanation-first review for the human, review lanes for monorepos, per-file approvals, using the AI the developer already has, trigger-only runs with token controls, and proof attachments.

## Suggested first version

1. Local changes panel: file list, area and change-type grouping, per-file approval.
2. Review packet + one backend (auto-detect: Copilot in VS Code, Cursor agent in Cursor), triggered by a button, with saved results.
3. Then: GitHub/GitLab PR view, synced comments, MCP chat tools.

## Mockups

The [`mockups/`](mockups) folder holds the four screens:

| File | Screen |
|---|---|
| `Main.dc.html` | Local changes review |
| `PRs.dc.html` | PR / MR review with lanes, teammate comments and proof |
| `Comments.dc.html` | Fixing teammate comments in the editor |
| `Settings.dc.html` | AI backend, triggers, token saving and MCP |

These are Claude design-canvas files: they need the canvas runtime (`support.js`) and won't open as standalone web pages. The sample data in them (an "order cancellation" change in a monorepo) is made up.
