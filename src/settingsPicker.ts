import * as vscode from 'vscode';

/*
 * A quick-pick editor for this extension's settings.
 *
 * We deliberately do not call `workbench.action.openSettings` from the extension: in Cursor that command
 * returns the whole Settings editor as its result, and serialising it back to the extension host freezes
 * the window. Everything here stays in the extension host and writes with the configuration API.
 */

const SECTION = 'reviewLens';

interface NumberSetting {
  key: string;
  label: string;
  min: number;
  max: number;
}

const BACKENDS: Array<{ value: string; label: string; detail: string }> = [
  { value: 'auto', label: 'Auto', detail: 'Copilot in VS Code, the Cursor agent in Cursor.' },
  { value: 'copilot', label: 'GitHub Copilot', detail: 'VS Code only. Uses your Copilot plan; no API key.' },
  { value: 'cursor', label: 'Cursor agent CLI', detail: 'Needs the Cursor CLI (`agent`) installed and signed in.' },
  { value: 'claude', label: 'Claude Code CLI', detail: 'Needs the `claude` CLI installed and signed in.' },
];

const NUMBERS: NumberSetting[] = [
  { key: 'contextLines', label: 'Context lines around each change', min: 0, max: 100 },
  { key: 'askBeforeTokens', label: 'Ask before reviews larger than (tokens)', min: 1000, max: 10_000_000 },
  { key: 'maxFileDiffChars', label: 'Shorten a single file’s changes above (characters)', min: 1000, max: 10_000_000 },
  { key: 'timeoutSeconds', label: 'CLI timeout (seconds)', min: 10, max: 3600 },
];

const TEXTS: Array<{ key: string; label: string }> = [
  { key: 'cursorCommand', label: 'Cursor agent CLI command' },
  { key: 'claudeCommand', label: 'Claude Code CLI command' },
];

function cfg() {
  return vscode.workspace.getConfiguration(SECTION);
}

/** Write where the value is currently set, so a workspace override isn't silently shadowed. */
function targetFor(key: string): vscode.ConfigurationTarget {
  const inspect = cfg().inspect(key);
  if (inspect?.workspaceFolderValue !== undefined) {
    return vscode.ConfigurationTarget.WorkspaceFolder;
  }
  if (inspect?.workspaceValue !== undefined) {
    return vscode.ConfigurationTarget.Workspace;
  }
  return vscode.ConfigurationTarget.Global;
}

async function update(key: string, value: unknown): Promise<void> {
  await cfg().update(key, value, targetFor(key));
}

async function pickBackend(): Promise<void> {
  const current = cfg().get<string>('backend', 'auto');
  const pick = await vscode.window.showQuickPick(
    BACKENDS.map((b) => ({ ...b, description: b.value === current ? 'current' : undefined, picked: b.value === current })),
    { title: 'AI backend', placeHolder: 'Which AI runs the review?' },
  );
  if (pick) {
    await update('backend', pick.value);
  }
}

async function editNumber(s: NumberSetting): Promise<void> {
  const current = cfg().get<number>(s.key);
  const value = await vscode.window.showInputBox({
    title: s.label,
    value: current === undefined ? '' : String(current),
    validateInput: (v) => {
      const n = Number(v);
      return Number.isInteger(n) && n >= s.min && n <= s.max ? undefined : `Enter a whole number from ${s.min} to ${s.max}.`;
    },
  });
  if (value !== undefined) {
    await update(s.key, Number(value));
  }
}

async function editText(key: string, label: string): Promise<void> {
  const current = cfg().get<string>(key, '');
  const value = await vscode.window.showInputBox({
    title: label,
    value: current,
    prompt: 'A command on your PATH, or a full path to the executable.',
    validateInput: (v) => (v.trim() ? undefined : 'Enter a command.'),
  });
  if (value !== undefined) {
    await update(key, value.trim());
  }
}

async function editAreas(): Promise<void> {
  const areas = cfg().get<Record<string, string[]>>('areas', {});
  const items = Object.entries(areas).map(([name, prefixes]) => ({ label: name, description: prefixes.join(', '), name }));
  const add = { label: '$(add) Add an area', description: '', name: '' };
  const pick = await vscode.window.showQuickPick([...items, add], {
    title: 'Areas',
    placeHolder: 'Pick an area to change its path prefixes, or add one',
  });
  if (!pick) {
    return;
  }
  let name = pick.name;
  if (!name) {
    const entered = await vscode.window.showInputBox({ title: 'New area name', placeHolder: 'For example: Mobile' });
    if (!entered?.trim()) {
      return;
    }
    name = entered.trim();
  }
  const value = await vscode.window.showInputBox({
    title: `Path prefixes for ${name}`,
    value: (areas[name] ?? []).join(', '),
    prompt: 'Comma-separated, for example: apps/mobile/, ios/. Leave empty to remove the area.',
  });
  if (value === undefined) {
    return;
  }
  const next = { ...areas };
  const prefixes = value
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (prefixes.length === 0) {
    delete next[name];
  } else {
    next[name] = prefixes;
  }
  await update('areas', next);
}

/** Shows every setting with its current value; picking one edits it. Loops until dismissed. */
export async function openSettingsPicker(): Promise<void> {
  for (;;) {
    const c = cfg();
    const backend = BACKENDS.find((b) => b.value === c.get<string>('backend', 'auto'));
    type Item = vscode.QuickPickItem & { run: () => Promise<void> };
    const items: Item[] = [
      { label: 'AI backend', description: backend?.label ?? c.get<string>('backend', 'auto'), run: pickBackend },
      ...TEXTS.map((t) => ({ label: t.label, description: c.get<string>(t.key, ''), run: () => editText(t.key, t.label) })),
      ...NUMBERS.map((n) => ({ label: n.label, description: String(c.get<number>(n.key)), run: () => editNumber(n) })),
      {
        label: 'Areas',
        description: Object.keys(c.get<Record<string, string[]>>('areas', {})).join(', ') || 'none',
        run: editAreas,
      },
    ];
    const pick = await vscode.window.showQuickPick(items, {
      title: 'ReviewLens settings',
      placeHolder: 'Pick a setting to change. Press Esc when done.',
    });
    if (!pick) {
      return;
    }
    await pick.run();
  }
}
