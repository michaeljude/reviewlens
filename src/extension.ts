import * as vscode from 'vscode';
import { Controller } from './controller';
import { openSettingsPicker } from './settingsPicker';
import { Store } from './store';
import { DetailPanel, SidebarProvider } from './views';

export function activate(context: vscode.ExtensionContext): void {
  const controller = new Controller(new Store(context.workspaceState));
  const detail = new DetailPanel(context.extensionUri, controller);
  const sidebar = new SidebarProvider(context.extensionUri, controller, detail);

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'workbench.view.extension.aiChangeReviewer';
  const updateStatus = () => {
    const s = controller.viewState();
    if (!s.root || s.files.length === 0) {
      status.hide();
      return;
    }
    const approved = s.files.filter((f) => f.decision === 'approved').length;
    status.text = `$(checklist) ${approved}/${s.files.length} approved`;
    status.tooltip = s.needsAiCount > 0 ? `${s.needsAiCount} file(s) not reviewed by AI yet` : 'AI review up to date';
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
    vscode.window.registerWebviewViewProvider(SidebarProvider.viewId, sidebar),
    vscode.commands.registerCommand('aiChangeReviewer.runReview', () => controller.runReview()),
    vscode.commands.registerCommand('aiChangeReviewer.refresh', () => controller.refresh()),
    vscode.commands.registerCommand('aiChangeReviewer.clearSavedResults', () => controller.clearSavedResults()),
    vscode.commands.registerCommand('aiChangeReviewer.openSettings', () => openSettingsPicker()),
    vscode.workspace.onDidSaveTextDocument(scheduleRefresh),
    vscode.workspace.onDidChangeWorkspaceFolders(scheduleRefresh),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('aiChangeReviewer')) {
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
