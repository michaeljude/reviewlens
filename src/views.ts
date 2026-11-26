import { randomBytes } from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import { categoryLabel } from './classify';
import { Controller, Mode } from './controller';
import { groupThreads, parsePatch } from './diff';
import { ReviewEvent } from './hosts';
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
  | { type: 'ready' | 'run' | 'refresh' | 'settings' | 'rules' | 'approveLowRisk' | 'signIn' | 'useToken' | 'back' | 'openPrWeb' | 'checkActivity' }
  | { type: 'submitReview'; event: ReviewEvent; body: string; summary: boolean }
  | { type: 'mode'; mode: Mode }
  | { type: 'selectPr'; number: number }
  | { type: 'open'; path: string }
  | { type: 'decide'; path: string; decision: Decision };

export class SidebarProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'reviewLens.changes';
  private view?: vscode.WebviewView;
  private lastSent?: string;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly controller: Controller,
    private readonly detail: DetailPanel,
  ) {
    controller.onDidChange(() => this.push());
    controller.watcher.onDidChange(() => this.updateBadge());
  }

  private updateBadge(): void {
    if (!this.view) {
      return;
    }
    const n = this.controller.watcher.totalUnread;
    this.view.badge = n > 0 ? { value: n, tooltip: `${n} new review update${n === 1 ? '' : 's'}` } : undefined;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')] };
    view.webview.html = html(view.webview, this.extensionUri, 'sidebar.js', 'ReviewLens');
    view.webview.onDidReceiveMessage((m: SidebarMessage) => this.onMessage(m));
    this.lastSent = undefined;
    this.updateBadge();
    view.onDidChangeVisibility(() => {
      if (view.visible) {
        void this.controller.refresh();
      }
    });
  }

  private onMessage(m: SidebarMessage): void {
    switch (m.type) {
      case 'ready':
        this.lastSent = undefined;
        this.push();
        break;
      case 'submitReview':
        void this.controller.submitReview(m.event, m.body, m.summary === true).then((ok) => {
          void this.view?.webview.postMessage({ type: 'done', key: 'review', ok });
        });
        break;
      case 'checkActivity':
        void this.controller.watcher.check(true);
        break;
      case 'run':
        void this.controller.runReview();
        break;
      case 'refresh':
        void this.controller.reload();
        break;
      case 'mode':
        void this.controller.setMode(m.mode);
        break;
      case 'signIn':
        void this.controller.signIn();
        break;
      case 'useToken':
        void this.controller.useToken();
        break;
      case 'selectPr':
        void this.controller.selectPr(m.number);
        break;
      case 'back':
        this.controller.backToList();
        break;
      case 'openPrWeb':
        this.controller.openPrOnWeb();
        break;
      case 'settings':
        void vscode.commands.executeCommand('reviewLens.openSettings');
        break;
      case 'rules':
        void vscode.commands.executeCommand('reviewLens.manageRules');
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

  /** Shows the panel if it has been opened before in this window. */
  reveal(): boolean {
    if (!this.view) {
      return false;
    }
    this.view.show(true);
    return true;
  }

  private push(): void {
    if (!this.view) {
      return;
    }
    // Skip identical states, so refreshes that bring nothing new don’t re-render (and disturb) the panel.
    const state = this.controller.viewState();
    const json = JSON.stringify(state);
    if (json === this.lastSent) {
      return;
    }
    this.lastSent = json;
    void this.view.webview.postMessage({ type: 'state', state });
  }
}

type DetailMessage =
  | { type: 'ready' | 'openDiff' | 'openFile' | 'runOne' | 'openWeb' | 'refresh' | 'rules' }
  | { type: 'openUrl'; url: string }
  | { type: 'openRule'; source: string }
  | { type: 'decide'; decision: Decision }
  | { type: 'comment'; key: string; oldLine?: number; newLine?: number; body: string }
  | { type: 'reply'; key: string; threadId: string; body: string }
  | { type: 'resolve'; key: string; threadId: string; resolved: boolean };

export class DetailPanel implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private current?: string;
  private running = false;
  private lastSent?: string;
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
    const panel = vscode.window.createWebviewPanel('reviewLens.detail', title, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    });
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'icon.svg');
    panel.webview.html = html(panel.webview, this.extensionUri, 'detail.js', title);
    panel.webview.onDidReceiveMessage((m: DetailMessage) => this.onMessage(m));
    panel.onDidDispose(() => {
      this.panel = undefined;
      this.lastSent = undefined;
    });
    this.panel = panel;
  }

  private async onMessage(m: DetailMessage): Promise<void> {
    const filePath = this.current;
    if (!filePath) {
      return;
    }
    const done = (key: string, ok: boolean) => void this.panel?.webview.postMessage({ type: 'done', key, ok });
    const lineNo = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined);
    switch (m.type) {
      case 'ready':
        this.lastSent = undefined;
        this.push();
        break;
      case 'decide':
        await this.controller.decide(filePath, m.decision);
        break;
      case 'refresh':
        await this.controller.reload();
        break;
      case 'comment':
        done(m.key, await this.controller.addComment(filePath, lineNo(m.oldLine), lineNo(m.newLine), m.body));
        break;
      case 'reply':
        done(m.key, await this.controller.replyToThread(filePath, String(m.threadId), m.body));
        break;
      case 'resolve':
        done(m.key, await this.controller.setThreadResolved(filePath, String(m.threadId), m.resolved === true));
        break;
      case 'openFile':
        await this.openFile(filePath);
        break;
      case 'openDiff':
        await this.openDiff(filePath);
        break;
      case 'openWeb': {
        const url = this.controller.prFileUrl(filePath);
        if (url) {
          await vscode.env.openExternal(vscode.Uri.parse(url));
        }
        break;
      }
      case 'rules':
        void vscode.commands.executeCommand('reviewLens.manageRules');
        break;
      case 'openRule': {
        // Only rule files the extension itself listed for this file.
        const root = this.controller.root;
        const rule = this.controller.entry(filePath)?.rules.find((r) => r.source === m.source && r.source !== 'settings');
        if (root && rule) {
          await vscode.window.showTextDocument(vscode.Uri.file(path.join(root, rule.source)), { viewColumn: vscode.ViewColumn.Beside, preview: false });
        } else if (m.source === 'settings') {
          void vscode.commands.executeCommand('reviewLens.manageRules');
        }
        break;
      }
      case 'openUrl':
        // Only links to the PR host that the extension itself put in the page.
        if (this.controller.commentsFor(filePath).some((c) => c.url === m.url)) {
          await vscode.env.openExternal(vscode.Uri.parse(m.url));
        }
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
    if (!uri) {
      return;
    }
    try {
      await vscode.window.showTextDocument(uri, { viewColumn: vscode.ViewColumn.Beside, preview: false });
    } catch {
      vscode.window.showInformationMessage(`${filePath} doesn't exist in your local copy. Check out the branch to edit it.`);
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
    const send = (detail: unknown) => {
      // Skip identical content, so refreshes that bring nothing new don’t re-render (and disturb) the page.
      const json = JSON.stringify(detail);
      if (json !== this.lastSent) {
        this.lastSent = json;
        void this.panel?.webview.postMessage({ type: 'detail', detail });
      }
    };
    const mode = this.controller.currentMode;
    if (!e) {
      send({
        exists: false,
        name: path.posix.basename(this.current),
        missingText: mode === 'pr' ? 'This file isn’t part of the open pull/merge request.' : 'This file has no uncommitted changes any more.',
        rows: [],
        threads: [],
      });
      return;
    }
    const rows = parsePatch(e.diff);
    const shown = rows.slice(0, MAX_DIFF_LINES);
    const threads = groupThreads(this.controller.commentsFor(e.file.path), rows).map((t) => (t.row >= shown.length ? { ...t, row: -1 } : t));
    const category = e.ruleCategory ?? e.analysis?.category;
    const dir = path.posix.dirname(e.file.path);
    send({
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
        rules: e.rules.map((r) => ({ title: r.title, kind: r.kind, severity: r.severity, source: r.source })),
        rulesOn: vscode.workspace.getConfiguration('reviewLens').get<boolean>('useRules', true),
        analysedBy: e.analysis ? e.analysedBy : undefined,
        decision: e.decision,
        running: this.running,
        mode,
        hostLabel: this.controller.hostLabel,
        tooLarge: e.tooLarge,
        threads,
        canComment: this.controller.canComment && !e.tooLarge && !e.file.binary,
        me: this.controller.currentUser,
        refreshing: this.controller.isRefreshing,
        rows: shown,
        diffTruncated: rows.length > MAX_DIFF_LINES,
    });
  }
}
