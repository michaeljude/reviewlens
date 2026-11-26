import * as vscode from 'vscode';
import { HostAuth } from './auth';
import { Controller } from './controller';
import { newRuleFile, openRulesMenu } from './rulesMenu';
import { openSettingsPicker } from './settingsPicker';
import { Store } from './store';
import { DetailPanel, SidebarProvider } from './views';

export function activate(context: vscode.ExtensionContext): void {
  const controller = new Controller(new Store(context.workspaceState), new HostAuth(context.secrets));
  const detail = new DetailPanel(context.extensionUri, controller);
  const sidebar = new SidebarProvider(context.extensionUri, controller, detail);

  // Always shown in a Git repository, so the panel is one click away even when the
  // editor hides its icon (Cursor pins only a few side bar icons). Clicking it is run by
  // the editor itself, not this extension, so nothing is sent back here.
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'workbench.view.extension.reviewLens';
  status.name = 'ReviewLens';
  const updateStatus = () => {
    const s = controller.viewState();
    if (!s.root) {
      status.hide();
      return;
    }
    const unread = controller.watcher.totalUnread;
    const bell = unread > 0 ? ` $(bell-dot) ${unread}` : '';
    if (s.files.length === 0) {
      status.text = `$(checklist) ReviewLens${bell}`;
      status.tooltip = unread > 0 ? `Open ReviewLens. ${unread} new review update(s).` : 'Open ReviewLens';
    } else {
      const approved = s.files.filter((f) => f.decision === 'approved').length;
      const where = s.mode === 'pr' && s.pr.selected ? ` (#${s.pr.selected.number})` : '';
      status.text = `$(checklist) ${approved}/${s.files.length} approved${where}${bell}`;
      status.tooltip = `Open ReviewLens. ${s.needsAiCount > 0 ? `${s.needsAiCount} file(s) not reviewed by AI yet.` : 'AI review up to date.'}${unread > 0 ? ` ${unread} new review update(s).` : ''}`;
    }
    status.show();
  };

  // Refresh the list (never the AI) when files change, debounced.
  let timer: NodeJS.Timeout | undefined;
  const scheduleRefresh = () => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => void controller.refresh(), 800);
  };
  const watcher = vscode.workspace.createFileSystemWatcher('**/*');
  const onFsEvent = (uri: vscode.Uri) => {
    if (!/[\\/](node_modules|\.git[\\/]objects)[\\/]/.test(uri.fsPath)) {
      scheduleRefresh();
    }
  };

  context.subscriptions.push(
    controller,
    detail,
    status,
    watcher,
    controller.onDidChange(updateStatus),
    controller.watcher.onDidChange(updateStatus),
    vscode.window.registerWebviewViewProvider(SidebarProvider.viewId, sidebar),
    vscode.commands.registerCommand('reviewLens.runReview', () => controller.runReview()),
    vscode.commands.registerCommand('reviewLens.refresh', () => controller.reload()),
    vscode.commands.registerCommand('reviewLens.showPullRequests', async () => {
      // Uses the view's own API, not a workbench command: some editors return large objects from those (see settingsPicker.ts).
      if (!sidebar.reveal()) {
        vscode.window.showInformationMessage('Open the ReviewLens panel from the activity bar, then pick the Pull requests tab.');
      }
      await controller.setMode('pr');
    }),
    vscode.commands.registerCommand('reviewLens.revealPanel', async () => {
      if (!sidebar.reveal()) {
        // The view's own focus command; it returns nothing (see the note above about workbench commands).
        await vscode.commands.executeCommand('reviewLens.changes.focus').then(undefined, () => undefined);
      }
    }),
    vscode.commands.registerCommand('reviewLens.checkActivity', () => controller.watcher.check(true)),
    vscode.commands.registerCommand('reviewLens.signIn', () => controller.signIn()),
    vscode.commands.registerCommand('reviewLens.useToken', () => controller.useToken()),
    vscode.commands.registerCommand('reviewLens.signOut', () => controller.signOut()),
    vscode.commands.registerCommand('reviewLens.clearSavedResults', () => controller.clearSavedResults()),
    vscode.commands.registerCommand('reviewLens.openSettings', () => openSettingsPicker()),
    vscode.commands.registerCommand('reviewLens.manageRules', () => openRulesMenu(controller)),
    vscode.commands.registerCommand('reviewLens.newRule', () => newRuleFile(controller, 'rule')),
    vscode.commands.registerCommand('reviewLens.newSkill', () => newRuleFile(controller, 'skill')),
    vscode.workspace.onDidSaveTextDocument(scheduleRefresh),
    vscode.workspace.onDidChangeWorkspaceFolders(scheduleRefresh),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('reviewLens')) {
        scheduleRefresh();
      }

    }),
    vscode.window.onDidChangeWindowState((s) => {
      if (s.focused) {
        scheduleRefresh();
      }
    }),
    watcher.onDidChange(onFsEvent),
    watcher.onDidCreate(onFsEvent),
    watcher.onDidDelete(onFsEvent),
    { dispose: () => timer && clearTimeout(timer) },
  );

  void controller.refresh();
}

export function deactivate(): void {}
