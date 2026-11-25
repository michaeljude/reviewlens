import * as path from 'path';
import * as vscode from 'vscode';
import { BACKEND_LABELS, BackendError, resolveBackend, runBackend } from './backends';
import { areaFor, CategoryId, categoryLabel, ruleCategory, skipForAi } from './classify';
import { ChangedFile, ChangeSet, fileDiff, listChanges, repoRoot } from './git';
import { buildPrompt, estimateTokens, FileAnalysis, hashDiff, PacketFile, parseReview, shorten, statusWord } from './review';
import { Decision, Store } from './store';

export interface FileEntry {
  file: ChangedFile;
  area: string;
  ruleCategory?: CategoryId;
  skipAi: boolean;
  diff: string;
  hash: string;
  analysis?: FileAnalysis;
  analysedBy?: string;
  decision?: Decision;
}

export interface FileView {
  path: string;
  name: string;
  dir: string;
  area: string;
  status: string;
  statusWord: string;
  added: number;
  deleted: number;
  binary: boolean;
  skipAi: boolean;
  category?: string;
  categoryLabel: string;
  needsAi: boolean;
  risk?: string;
  decision?: Decision;
}

export interface ViewState {
  root?: string;
  message?: string;
  running: boolean;
  backendLabel: string;
  files: FileView[];
  summary?: string;
  summaryAt?: number;
  needsAiCount: number;
}

function config() {
  return vscode.workspace.getConfiguration('aiChangeReviewer');
}

export class Controller implements vscode.Disposable {
  private entries: FileEntry[] = [];
  private changeSet?: ChangeSet;
  private message?: string = 'Loading changes…';
  private refreshSeq = 0;
  private running = false;
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  constructor(private readonly store: Store) {}

  dispose(): void {
    this.emitter.dispose();
  }

  get root(): string | undefined {
    return this.changeSet?.root;
  }

  entry(filePath: string): FileEntry | undefined {
    return this.entries.find((e) => e.file.path === filePath);
  }

  private async findRoot(): Promise<string | undefined> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const active = vscode.window.activeTextEditor?.document.uri;
    const ordered = active
      ? [...folders].sort((a, b) => Number(active.fsPath.startsWith(b.uri.fsPath)) - Number(active.fsPath.startsWith(a.uri.fsPath)))
      : folders;
    for (const f of ordered) {
      if (f.uri.scheme !== 'file') {
        continue;
      }
      const root = await repoRoot(f.uri.fsPath);
      if (root) {
        return root;
      }
    }
    return undefined;
  }

  async refresh(): Promise<void> {
    const seq = ++this.refreshSeq;
    try {
      const root = await this.findRoot();
      if (!root) {
        if (seq === this.refreshSeq) {
          this.entries = [];
          this.changeSet = undefined;
          this.message = 'Open a folder that is a Git repository to review its changes.';
          this.emitter.fire();
        }
        return;
      }
      const set = await listChanges(root);
      const contextLines = config().get<number>('contextLines', 10);
      const areas = config().get<Record<string, string[]>>('areas', {});
      const entries: FileEntry[] = [];
      for (let i = 0; i < set.files.length; i += 8) {
        const batch = set.files.slice(i, i + 8);
        const diffs = await Promise.all(batch.map((f) => fileDiff(set, f, contextLines)));
        batch.forEach((file, j) => {
          const diff = diffs[j];
          const hash = hashDiff(file.path, file.binary ? `binary:${file.status}` : diff);
          const saved = this.store.getAnalysis(hash);
          entries.push({
            file,
            area: areaFor(file.path, areas),
            ruleCategory: ruleCategory(file.path),
            skipAi: file.binary || file.status === 'D' || skipForAi(file.path),
            diff,
            hash,
            analysis: saved?.analysis,
            analysedBy: saved?.backend,
            decision: this.store.getDecision(file.path, hash),
          });
        });
      }
      if (seq !== this.refreshSeq) {
        return;
      }
      this.changeSet = set;
      this.entries = entries;
      this.message = entries.length === 0 ? 'No uncommitted changes.' : undefined;
      this.emitter.fire();
    } catch (e) {
      if (seq === this.refreshSeq) {
        this.message = `Couldn't read Git changes: ${(e as Error).message}`;
        this.emitter.fire();
      }
    }
  }

  async decide(filePath: string, decision: Decision): Promise<void> {
    const e = this.entry(filePath);
    if (!e) {
      return;
    }
    e.decision = e.decision === decision ? undefined : decision;
    await this.store.setDecision(filePath, e.hash, e.decision);
    this.emitter.fire();
  }

  async approveLowRisk(): Promise<void> {
    for (const e of this.entries) {
      if (!e.decision && e.analysis?.risk === 'low') {
        e.decision = 'approved';
        await this.store.setDecision(e.file.path, e.hash, 'approved');
      }
    }
    this.emitter.fire();
  }

  async clearSavedResults(): Promise<void> {
    await this.store.clearAnalyses();
    await this.refresh();
  }

  backendLabel(): string {
    const setting = config().get<string>('backend', 'auto');
    const id = resolveBackend(setting);
    return setting === 'auto' ? `Auto (${BACKEND_LABELS[id]})` : BACKEND_LABELS[id];
  }

  private needsAi(e: FileEntry): boolean {
    return !e.skipAi && !e.analysis;
  }

  async runReview(onlyPath?: string): Promise<void> {
    if (this.running) {
      return;
    }
    await this.refresh();
    const set = this.changeSet;
    if (!set) {
      vscode.window.showInformationMessage(this.message ?? 'Nothing to review.');
      return;
    }
    const pending = this.entries.filter((e) => this.needsAi(e) && (!onlyPath || e.file.path === onlyPath));
    if (pending.length === 0) {
      vscode.window.showInformationMessage('AI review is up to date. Nothing changed since the last run, so nothing was sent.');
      return;
    }
    const maxChars = config().get<number>('maxFileDiffChars', 20000);
    const packet: PacketFile[] = pending.map((e) => {
      const s = shorten(e.diff, maxChars);
      return {
        path: e.file.path,
        area: e.area,
        status: e.file.status,
        categoryHint: e.ruleCategory,
        diff: s.diff,
        shortened: s.shortened,
      };
    });
    const pendingPaths = new Set(pending.map((e) => e.file.path));
    const others = this.entries.filter((e) => !pendingPaths.has(e.file.path)).map((e) => e.file.path);
    const prompt = buildPrompt(packet, others);
    const tokens = estimateTokens(prompt);
    const askAbove = config().get<number>('askBeforeTokens', 50000);
    if (tokens > askAbove) {
      const go = await vscode.window.showWarningMessage(
        `This review is about ${Math.round(tokens / 1000)}k tokens for ${pending.length} file(s). Send it?`,
        { modal: true },
        'Send',
      );
      if (go !== 'Send') {
        return;
      }
    }

    const backendId = resolveBackend(config().get<string>('backend', 'auto'));
    const label = BACKEND_LABELS[backendId];
    this.running = true;
    this.emitter.fire();
    try {
      const reply = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Reviewing ${pending.length} file${pending.length === 1 ? '' : 's'} with ${label}`,
          cancellable: true,
        },
        (_progress, token) =>
          runBackend(
            backendId,
            prompt,
            {
              cwd: set.root,
              timeoutSeconds: config().get<number>('timeoutSeconds', 300),
              cursorCommand: config().get<string>('cursorCommand', 'agent'),
              claudeCommand: config().get<string>('claudeCommand', 'claude'),
            },
            token,
          ),
      );
      const result = parseReview(reply);
      const saved: Array<{ hash: string; analysis: FileAnalysis }> = [];
      for (const e of pending) {
        const a = result.files.get(e.file.path);
        if (a) {
          e.analysis = a;
          e.analysedBy = label;
          saved.push({ hash: e.hash, analysis: a });
        }
      }
      await this.store.saveAnalyses(saved, label);
      if (result.summary && !onlyPath) {
        await this.store.saveSummary(result.summary, label);
      }
      const missing = pending.length - saved.length;
      if (missing > 0) {
        vscode.window.showWarningMessage(`The AI skipped ${missing} file(s). Run the review again to retry them.`);
      }
    } catch (e) {
      if (e instanceof vscode.CancellationError) {
        return;
      }
      const msg = e instanceof BackendError || e instanceof Error ? e.message : String(e);
      // Not awaited, so the panel leaves its "Reviewing…" state while the message is still showing.
      void vscode.window.showErrorMessage(`AI review failed. ${msg}`, 'Open settings').then((pick) => {
        if (pick === 'Open settings') {
          void vscode.commands.executeCommand('aiChangeReviewer.openSettings');
        }
      });
    } finally {
      this.running = false;
      this.emitter.fire();
    }
  }

  viewState(): ViewState {
    const files: FileView[] = this.entries.map((e) => {
      const category = e.ruleCategory ?? e.analysis?.category;
      return {
        path: e.file.path,
        name: path.posix.basename(e.file.path),
        dir: path.posix.dirname(e.file.path) === '.' ? '' : path.posix.dirname(e.file.path),
        area: e.area,
        status: e.file.status,
        statusWord: statusWord(e.file.status),
        added: e.file.added,
        deleted: e.file.deleted,
        binary: e.file.binary,
        skipAi: e.skipAi,
        category,
        categoryLabel: categoryLabel(category),
        needsAi: this.needsAi(e),
        risk: e.analysis?.risk,
        decision: e.decision,
      };
    });
    const summary = this.store.getSummary();
    return {
      root: this.changeSet?.root,
      message: this.message,
      running: this.running,
      backendLabel: this.backendLabel(),
      files,
      summary: summary?.text,
      summaryAt: summary?.at,
      needsAiCount: files.filter((f) => f.needsAi).length,
    };
  }
}
