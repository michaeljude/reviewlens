# AI Change Reviewer

Understand and approve AI-written code changes, file by file.

When an AI agent changes many files at once, AI Change Reviewer lists what changed, groups it by area of your repo or by type of change, and, when you ask, explains **why** each file changed, **what** changed and **what it might affect**. You approve or request changes per file, right in the editor.

Works in **VS Code** and **Cursor**. AI only runs when you press the button.

> **Preview.** This is an early release that covers your local, uncommitted changes. Pull request and merge request review is planned.

![Change Review panel and a file's review](images/screenshot-review.png)

## Features

- **All your uncommitted changes in one list:** staged, unstaged and new files, with added and removed line counts.
- **Group by area or by change type.** Areas come from path prefixes you set, such as `apps/mobile/` or `services/`, which suits monorepos. Change types include UI, business logic, API, shared types, database, tests, infra, CI/CD, automation, config and docs.
- **Spots missing tests:** warns when code that changes behaviour changed but no test files did.
- **AI explanations on demand:** for each file, why it changed, what changed, possible impact with a risk level, and the diff.
- **Approve per file:** tick a file in the list, or use **Approve file** / **Request changes** in its review. An approval clears automatically if the file changes afterwards. The status bar shows how many files are approved.
- **Uses the AI you already have:** GitHub Copilot in VS Code, or the Cursor agent or Claude Code CLI. No extra account or API key needed.

## Getting started

1. Open a folder that is a Git repository and click **Change Review** in the activity bar.
2. Browse your changes. Nothing is sent to any AI yet.
3. Click **Run AI on N files**, or run **Change Review: Run AI review** from the command palette.
4. Click a file to read its review, then approve it or request changes.

### Choosing the AI

Set `aiChangeReviewer.backend`:

| Value | Uses | Needs |
|---|---|---|
| `auto` (default) | Copilot in VS Code, the Cursor agent in Cursor | See below |
| `copilot` | GitHub Copilot through VS Code's language model API | Copilot installed and signed in; VS Code asks once for permission. Not available in Cursor. |
| `cursor` | The Cursor agent CLI (`agent`) | [Cursor CLI](https://cursor.com/docs/cli) installed and signed in |
| `claude` | The Claude Code CLI (`claude`) | Claude Code installed and signed in |

## Keeping AI usage low

- AI never runs on its own: only when you press the button or run the command.
- Results are saved per version of each file, so files you have already reviewed aren't sent again.
- Only the changed sections plus a few lines of context are sent, not whole files.
- All files go in one request per review.
- Lockfiles, binary files, deleted files and build output are never sent.
- You're asked first when a review would be larger than `aiChangeReviewer.askBeforeTokens`.

## Privacy

When you run a review, the changed sections of your files (and their paths) are sent to the AI backend you chose: GitHub Copilot, Cursor or Claude Code, under that provider's terms. Nothing is sent until you run a review, and the extension itself collects no telemetry. Saved results and approvals stay in your editor's workspace storage.

## Settings

Click the gear in the Change Review panel, or run **Change Review: Settings**, to change these from a quick menu. You can also edit them in your editor's settings.

| Setting | Default | What it does |
|---|---|---|
| `aiChangeReviewer.backend` | `auto` | Which AI runs the review (see above) |
| `aiChangeReviewer.cursorCommand` | `agent` | Command or full path for the Cursor agent CLI |
| `aiChangeReviewer.claudeCommand` | `claude` | Command or full path for the Claude Code CLI |
| `aiChangeReviewer.contextLines` | `10` | Lines of context sent around each change |
| `aiChangeReviewer.askBeforeTokens` | `50000` | Ask before sending a bigger review |
| `aiChangeReviewer.maxFileDiffChars` | `20000` | Shorten a single file's changes above this size |
| `aiChangeReviewer.timeoutSeconds` | `300` | Give up on a CLI backend after this long |
| `aiChangeReviewer.areas` | Mobile / Web / Backend / Shared | Path prefixes that define your repo's areas |

## Known limitations

- Reviews uncommitted local changes only; pull and merge requests aren't supported yet.
- Renamed files show as a deleted file plus a new file.
- With a CLI backend, the CLI must be installed and signed in on your machine.

## Roadmap

Pull request and merge request review for GitHub and GitLab with per-area review lanes, teammate comments you can resolve in the editor, proof attachments (screenshots and recordings), an own-API-key backend and chat tools over MCP. See the [concept](docs/CONCEPT.md) and the [mockups](mockups).

## Building from source

```bash
git clone https://github.com/michaeljude/ai-change-reviewer.git
cd ai-change-reviewer
npm install
npm test
npm run package
```

`npm run package` builds a `.vsix` you can install with **Extensions: Install from VSIX…**. To work on the extension, open the folder and press **F5**.

## License

[MIT](LICENSE)
