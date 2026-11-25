import { randomBytes } from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import { categoryLabel } from './classify';
import { Controller } from './controller';
import { statusWord } from './review';
import { Decision } from './store';

const MAX_DIFF_LINES = 800;

function html(webview: vscode.Webview, extensionUri: vscode.Uri, script: string, title: string): string {
  const nonce = randomBytes(16).toString('base64');
  const media = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', f));
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${media('style.css')}">
<title>${title}</title>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${media('common.js')}"></script>
<script nonce="${nonce}" src="${media(script)}"></script>
</body>
</html>`;
}

type SidebarMessage =
  | { type: 'ready' | 'run' | 'refresh' | 'settings' | 'approveLowRisk' }
  | { type: 'open'; path: string }
  | { type: 'decide'; path: string; decision: Decision };

export class SidebarProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'aiChangeReviewer.changes';
  private view?: vscode.WebviewView;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly controller: Controller,
    private readonly detail: DetailPanel,
  ) {
    controller.onDidChange(() => this.push());
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')] };
    view.webview.html = html(view.webview, this.extensionUri, 'sidebar.js', 'Change Review');
    view.webview.onDidReceiveMessage((m: SidebarMessage) => this.onMessage(m));
    view.onDidChangeVisibility(() => {
      if (view.visible) {
        void this.controller.refresh();
      }
    });
  }

  private onMessage(m: SidebarMessage): void {
    switch (m.type) {
      case 'ready':
        this.push();
        break;
      case 'run':
        void this.controller.runReview();
        break;
      case 'refresh':
        void this.controller.refresh();
        break;
      case 'settings':
        void vscode.commands.executeCommand('aiChangeReviewer.openSettings');
        break;
      case 'approveLowRisk':
        void this.controller.approveLowRisk();
        break;
      case 'open':
        this.detail.show(m.path);
        break;
      case 'decide':
        void this.controller.decide(m.path, m.decision);
        break;
    }
  }

  private push(): void {
    void this.view?.webview.postMessage({ type: 'state', state: this.controller.viewState() });
  }
}

type DetailMessage =
  | { type: 'ready' | 'openDiff' | 'openFile' | 'runOne' }
  | { type: 'decide'; decision: Decision };

export class DetailPanel implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private current?: string;
  private running = false;
  private readonly subs: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly controller: Controller,
  ) {
    this.subs.push(controller.onDidChange(() => this.push()));
  }

  dispose(): void {
    this.panel?.dispose();
    this.subs.forEach((s) => s.dispose());
  }

  show(filePath: string): void {
    this.current = filePath;
    const title = `Review: ${path.posix.basename(filePath)}`;
    if (this.panel) {
      this.panel.title = title;
      this.panel.reveal(vscode.ViewColumn.Active, false);
      this.push();
      return;
    }
    const panel = vscode.window.createWebviewPanel('aiChangeReviewer.detail', title, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    });
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'icon.svg');
    panel.webview.html = html(panel.webview, this.extensionUri, 'detail.js', title);
    panel.webview.onDidReceiveMessage((m: DetailMessage) => this.onMessage(m));
    panel.onDidDispose(() => {
      this.panel = undefined;
    });
    this.panel = panel;
  }

  private async onMessage(m: DetailMessage): Promise<void> {
    const filePath = this.current;
    if (!filePath) {
      return;
    }
    switch (m.type) {
      case 'ready':
        this.push();
        break;
      case 'decide':
        await this.controller.decide(filePath, m.decision);
        break;
      case 'openFile':
        await this.openFile(filePath);
        break;
      case 'openDiff':
        await this.openDiff(filePath);
        break;
      case 'runOne':
        this.running = true;
        this.push();
        try {
          await this.controller.runReview(filePath);
        } finally {
          this.running = false;
          this.push();
        }
        break;
    }
  }

  private uri(filePath: string): vscode.Uri | undefined {
    const root = this.controller.root;
    return root ? vscode.Uri.file(path.join(root, filePath)) : undefined;
  }

  private async openFile(filePath: string): Promise<void> {
    const uri = this.uri(filePath);
    if (uri) {
      await vscode.window.showTextDocument(uri, { viewColumn: vscode.ViewColumn.Beside, preview: false });
    }
  }

  private async openDiff(filePath: string): Promise<void> {
    const uri = this.uri(filePath);
    if (!uri) {
      return;
    }
    try {
      await vscode.commands.executeCommand('git.openChange', uri);
    } catch {
      await this.openFile(filePath);
    }
  }

  private push(): void {
    if (!this.panel || !this.current) {
      return;
    }
    const e = this.controller.entry(this.current);
    if (!e) {
      void this.panel.webview.postMessage({
        type: 'detail',
        detail: { exists: false, name: path.posix.basename(this.current), diffLines: [] },
      });
      return;
    }
    const all = e.diff ? e.diff.split('\n') : [];
    const category = e.ruleCategory ?? e.analysis?.category;
    const dir = path.posix.dirname(e.file.path);
    void this.panel.webview.postMessage({
      type: 'detail',
      detail: {
        exists: true,
        path: e.file.path,
        name: path.posix.basename(e.file.path),
        dir: dir === '.' ? '' : dir,
        area: e.area,
        categoryLabel: categoryLabel(category),
        status: e.file.status,
        statusWord: statusWord(e.file.status),
        added: e.file.added,
        deleted: e.file.deleted,
        binary: e.file.binary,
        skipAi: e.skipAi,
        analysis: e.analysis,
        analysedBy: e.analysis ? e.analysedBy : undefined,
        decision: e.decision,
        running: this.running,
        diffLines: all.slice(0, MAX_DIFF_LINES),
        diffTruncated: all.length > MAX_DIFF_LINES,
      },
    });
  }
}
