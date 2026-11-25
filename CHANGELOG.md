# Changelog

## 0.0.2 (preview)

- Fixed: opening the extension's settings froze Cursor. Settings now open as a quick menu inside the editor that shows each setting's current value and lets you change it, including areas.
- Clearer error when an AI CLI fails, with a sign-in hint when its login has expired.

## 0.0.1 (preview)

First release.

- Change Review panel listing uncommitted changes (staged, unstaged and new files).
- Group by area (configurable path prefixes) or by change type; obvious files are categorised by path rules without AI.
- Warning when code that changes behaviour changed but no tests did.
- **Run AI review** on demand only. Results are saved per file version, so unchanged files are never sent again. Asks before large reviews.
- AI backends: GitHub Copilot (VS Code), Cursor agent CLI and Claude Code CLI. Auto-detect picks Copilot in VS Code and the Cursor agent in Cursor.
- File detail view: why it changed, what changed, possible impact with risk, and the diff.
- Per-file **Approve** / **Request changes**, a checkbox in the list, and an approved count in the status bar. Approval clears when the file changes.
