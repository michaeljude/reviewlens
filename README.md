# ReviewLens

Understand and approve AI-written code changes, file by file.

When an AI agent changes many files at once, ReviewLens lists what changed, groups it by area of your repo or by type of change, and, when you ask, explains **why** each file changed, **what** changed and **what it might affect**. You approve or request changes per file, right in the editor. It works on your **local uncommitted changes** and on **GitHub pull requests** and **GitLab merge requests**.

Works in **VS Code** and **Cursor**. AI only runs when you press the button.

> **Preview.** An early release: reviewing pull and merge requests is read-only for now, so comments and approvals stay in the editor and aren't posted back to GitHub or GitLab yet.

![ReviewLens panel and a file's review](images/screenshot-review.png)

## Features

- **All your uncommitted changes in one list:** staged, unstaged and new files, with added and removed line counts.
- **Group by area or by change type.** Areas come from path prefixes you set, such as `apps/mobile/` or `services/`, which suits monorepos. Change types include UI, business logic, API, shared types, database, tests, infra, CI/CD, automation, config and docs.
- **Spots missing tests:** warns when code that changes behaviour changed but no test files did.
- **AI explanations on demand:** for each file, why it changed, what changed, possible impact with a risk level, and the diff.
- **Approve per file:** tick a file in the list, or use **Approve file** / **Request changes** in its review. An approval clears automatically if the file changes afterwards. The status bar shows how many files are approved.
- **Uses the AI you already have:** GitHub Copilot in VS Code, or the Cursor agent or Claude Code CLI. No extra account or API key needed.
- **Pull and merge requests:** open PRs from GitHub or MRs from GitLab (including self-hosted), with the ones waiting for your review first. Their files are grouped into the same area lanes, the AI also reads the PR's title and description, and teammates' comments show on each file.

## Getting started

1. Open a folder that is a Git repository and click **ReviewLens** in the activity bar.
2. Browse your changes. Nothing is sent to any AI yet.
3. Click **Run AI on N files**, or run **ReviewLens: Run AI review** from the command palette.
4. Click a file to read its review, then approve it or request changes.

### Reviewing a pull or merge request

1. In the ReviewLens panel, switch to the **Pull requests** tab (**Merge requests** on GitLab). ReviewLens uses your repository's `origin` remote to find the project.
2. Sign in:
   - **GitHub:** click **Sign in to GitHub** to use your editor's GitHub account, or **Use a personal access token** (read access to pull requests and contents is enough).
   - **GitLab:** click **Add a GitLab access token** and paste a personal access token with the `read_api` scope. For a self-hosted server whose name doesn't contain "gitlab", add it to `reviewLens.gitlabHosts`.
3. Pick a pull or merge request, then run the AI review and approve file by file as for local changes.

Tokens are kept in the editor's secure storage. **ReviewLens: Remove saved access token** deletes them.

### Choosing the AI

Set `reviewLens.backend`:

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
- You're asked first when a review would be larger than `reviewLens.askBeforeTokens`.

## Privacy

When you run a review, the changed sections of your files (and their paths) are sent to the AI backend you chose: GitHub Copilot, Cursor or Claude Code, under that provider's terms. For a pull or merge request, its title and description are sent too. Nothing is sent until you run a review, and the extension itself collects no telemetry. Saved results and approvals stay in your editor's workspace storage.

For pull and merge requests, ReviewLens reads from the GitHub or GitLab API with your sign-in or token. It only reads; it doesn't post anything.

## Settings

Click the gear in the ReviewLens panel, or run **ReviewLens: Settings**, to change these from a quick menu. You can also edit them in your editor's settings.

| Setting | Default | What it does |
|---|---|---|
| `reviewLens.backend` | `auto` | Which AI runs the review (see above) |
| `reviewLens.cursorCommand` | `agent` | Command or full path for the Cursor agent CLI |
| `reviewLens.claudeCommand` | `claude` | Command or full path for the Claude Code CLI |
| `reviewLens.contextLines` | `10` | Lines of context sent around each change |
| `reviewLens.askBeforeTokens` | `50000` | Ask before sending a bigger review |
| `reviewLens.maxFileDiffChars` | `20000` | Shorten a single file's changes above this size |
| `reviewLens.timeoutSeconds` | `300` | Give up on a CLI backend after this long |
| `reviewLens.areas` | Mobile / Web / Backend / Shared | Path prefixes that define your repo's areas |
| `reviewLens.gitlabHosts` | none | Self-hosted GitLab servers whose names don't contain "gitlab" |

## Known limitations

- Pull and merge request review is read-only: approvals and comments aren't posted back yet.
- GitHub Enterprise Server isn't supported yet (github.com only).
- Very large files in a pull request come without their diff from GitHub/GitLab, so they can't be reviewed by AI in the editor.
- In local changes, renamed files show as a deleted file plus a new file.
- With a CLI backend, the CLI must be installed and signed in on your machine.

## Roadmap

Posting reviews, comments and approvals back to GitHub and GitLab; replying to and resolving teammates' comments in the editor and applying their suggestions; code owners per lane; proof attachments (screenshots and recordings); an own-API-key backend; and chat tools over MCP. See the [concept](docs/CONCEPT.md) and the [mockups](mockups).

## Building from source

```bash
git clone https://github.com/michaeljude/reviewlens.git
cd reviewlens
npm install
npm test
npm run package
```

`npm run package` builds a `.vsix` you can install with **Extensions: Install from VSIX…**. To work on the extension, open the folder and press **F5**.

## License

[MIT](LICENSE)
