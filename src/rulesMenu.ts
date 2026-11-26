import * as path from 'path';
import * as vscode from 'vscode';
import { Controller } from './controller';
import { ReviewRule, RuleKind, RULES_DIR, ruleTemplate, SKILLS_DIR, slugify } from './reviewRules';

/*
 * A quick-pick menu for the developer's review rules and skills: lists them, opens their files,
 * creates new ones from a template and manages personal rules kept in settings.
 * Like settingsPicker.ts, it never calls workbench settings commands (they freeze Cursor).
 */

function cfg() {
  return vscode.workspace.getConfiguration('reviewLens');
}

function scopeText(r: ReviewRule): string {
  return r.globs.length ? r.globs.join(', ') : 'all files';
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

/** Creates a rule or skill file from a template and opens it. */
export async function newRuleFile(controller: Controller, kind: RuleKind): Promise<void> {
  const root = controller.root;
  if (!root) {
    vscode.window.showInformationMessage('Open a folder that is a Git repository first. Rules are kept in its .reviewlens folder.');
    return;
  }
  const noun = kind === 'rule' ? 'rule' : 'skill';
  const title = await vscode.window.showInputBox({
    title: `New review ${noun}`,
    prompt:
      kind === 'rule'
        ? 'A short name for the rule. You write the rule itself in the file that opens next.'
        : 'A short name for the skill, such as “Security review” or “Mobile release checklist”.',
    placeHolder: kind === 'rule' ? 'For example: No personal data in logs' : 'For example: Security review',
    validateInput: (v) => (v.trim() ? undefined : 'Enter a name.'),
  });
  if (!title?.trim()) {
    return;
  }
  const slug = slugify(title.trim());
  const rel = kind === 'rule' ? `${RULES_DIR}/${slug}.md` : `${SKILLS_DIR}/${slug}/SKILL.md`;
  const uri = vscode.Uri.file(path.join(root, rel));
  if (!(await exists(uri))) {
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(uri.fsPath)));
    await vscode.workspace.fs.writeFile(uri, Buffer.from(ruleTemplate(kind, title.trim()), 'utf8'));
  }
  await vscode.window.showTextDocument(uri, { preview: false });
  void controller.refresh();
}

/** Adds, edits or removes the personal one-line rules kept in settings. */
async function editPersonalRules(controller: Controller): Promise<void> {
  for (;;) {
    const list = (cfg().get<unknown[]>('personalRules', []) ?? []).filter((x): x is string => typeof x === 'string');
    type Item = vscode.QuickPickItem & { index: number };
    const items: Item[] = list.map((text, index) => ({ label: text.split('\n')[0], detail: 'Pick to change or remove', index }));
    const add: Item = { label: '$(add) Add a personal rule', index: -1 };
    const pick = await vscode.window.showQuickPick([...items, add], {
      title: 'Personal review rules',
      placeHolder: 'Kept in your user settings and applied to every file in every repository. Esc when done.',
    });
    if (!pick) {
      return;
    }
    const value = await vscode.window.showInputBox({
      title: pick.index < 0 ? 'New personal rule' : 'Change the rule (leave empty to remove it)',
      value: pick.index < 0 ? '' : list[pick.index],
      placeHolder: 'For example: Flag any new TODO without a ticket number.',
    });
    if (value === undefined) {
      continue;
    }
    const next = [...list];
    if (pick.index < 0) {
      if (!value.trim()) {
        continue;
      }
      next.push(value.trim());
    } else if (value.trim()) {
      next[pick.index] = value.trim();
    } else {
      next.splice(pick.index, 1);
    }
    await cfg().update('personalRules', next, vscode.ConfigurationTarget.Global);
    await controller.refresh();
  }
}

/** Lists the rules and skills in use; picking one opens it. Loops until dismissed. */
export async function openRulesMenu(controller: Controller): Promise<void> {
  for (;;) {
    await controller.refresh();
    const set = controller.ruleSet;
    const root = controller.root;
    const enabled = cfg().get<boolean>('useRules', true);
    type Item = vscode.QuickPickItem & { run?: () => Promise<boolean | void> };
    const ruleItem = (r: ReviewRule): Item => ({
      label: `${r.kind === 'rule' ? '$(checklist)' : '$(book)'} ${r.title}`,
      description: [r.enabled ? undefined : 'off', r.kind === 'rule' ? r.severity : undefined, scopeText(r)].filter(Boolean).join(' · '),
      detail: r.source === 'settings' ? 'Personal rule (settings)' : r.description ? `${r.source} · ${r.description}` : r.source,
      run: async () => {
        if (r.source === 'settings') {
          await editPersonalRules(controller);
        } else if (root) {
          await vscode.window.showTextDocument(vscode.Uri.file(path.join(root, r.source)), { preview: false });
          return true;
        }
      },
    });
    const rules = set.rules.filter((r) => r.kind === 'rule');
    const skills = set.rules.filter((r) => r.kind === 'skill');
    const sep = (label: string): Item => ({ label, kind: vscode.QuickPickItemKind.Separator });
    const items: Item[] = [
      {
        label: enabled ? '$(pass-filled) Rules are on' : '$(circle-large-outline) Rules are off',
        description: enabled ? 'the AI checks changes against the rules below' : 'reviews ignore the rules below',
        detail: 'Pick to turn ' + (enabled ? 'off' : 'on'),
        run: async () => {
          await cfg().update('useRules', !enabled, vscode.ConfigurationTarget.Workspace);
        },
      },
      sep('Rules'),
      ...(rules.length ? rules.map(ruleItem) : [{ label: 'No rules yet', description: `add .md files to ${RULES_DIR}/` }]),
      sep('Skills'),
      ...(skills.length ? skills.map(ruleItem) : [{ label: 'No skills yet', description: `add ${SKILLS_DIR}/<name>/SKILL.md` }]),
      ...(set.problems.length ? [sep('Problems'), ...set.problems.map((p) => ({ label: '$(warning) ' + p }))] : []),
      sep('Add'),
      { label: '$(add) New rule…', description: `shared with your team in ${RULES_DIR}/`, run: () => newRuleFile(controller, 'rule').then(() => true) },
      { label: '$(add) New skill…', description: `a review playbook in ${SKILLS_DIR}/`, run: () => newRuleFile(controller, 'skill').then(() => true) },
      { label: '$(person) Personal rules…', description: 'just for you, in your user settings', run: () => editPersonalRules(controller) },
    ];
    const pick = await vscode.window.showQuickPick(items, {
      title: 'ReviewLens review rules',
      placeHolder: 'Rules and skills the AI follows when it reviews changes. Pick one to open it. Esc when done.',
      matchOnDescription: true,
    });
    if (!pick) {
      return;
    }
    if (!pick.run) {
      continue;
    }
    // A pick that opened a file ends the menu, so the file can be edited.
    if ((await pick.run()) === true) {
      return;
    }
  }
}
