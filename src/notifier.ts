import * as vscode from 'vscode';
import { activityItems, describeActivity, unseen } from './activity';
import { Host, PullRequest } from './hosts';
import { Store } from './store';

export interface WatcherDeps {
  /** The signed-in host, without prompting. Undefined when not signed in. */
  host(): Promise<Host | undefined>;
  /** Opens a pull/merge request in the ReviewLens panel. */
  open(num: number): Promise<void>;
  /** The pull/merge request open in the panel, whose activity is already on screen. */
  current(): number | undefined;
  /** A fresh list of open pull/merge requests, so the panel's list stays current too. */
  onList(list: PullRequest[]): void;
}

const MAX_OWN_PRS = 20;
/** Re-read an own PR's comments at least this often, even when its "updated" time hasn't moved. */
const RECHECK_MS = 10 * 60 * 1000;

function config() {
  return vscode.workspace.getConfiguration('reviewLens');
}

/**
 * Tells the developer about activity on GitHub/GitLab: new review requests for them, and comments, approvals and
 * change requests from others on their own pull/merge requests. Checks only when asked (the Refresh button or the
 * "Check for review activity now" command); nothing polls in the background, and nothing is sent to any AI.
 */
export class ActivityWatcher implements vscode.Disposable {
  private busy = false;
  private project?: string;
  private readonly checked = new Map<number, { updatedAt: string; at: number }>();
  private readonly unread = new Map<number, number>();
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  constructor(
    private readonly store: Store,
    private readonly deps: WatcherDeps,
  ) {}

  get enabled(): boolean {
    return config().get<boolean>('notifications.enabled', true);
  }

  dispose(): void {
    this.emitter.dispose();
  }

  unreadFor(num: number): number {
    return this.unread.get(num) ?? 0;
  }

  get totalUnread(): number {
    let n = 0;
    this.unread.forEach((v) => (n += v));
    return n;
  }

  markRead(num: number): void {
    if (this.unread.delete(num)) {
      this.emitter.fire();
    }
  }

  private bump(num: number, by: number): void {
    this.unread.set(num, (this.unread.get(num) ?? 0) + by);
  }

  /**
   * Checks now. `manual` reports problems and "nothing new" instead of staying quiet.
   * `known` is a list of open pull/merge requests just read, to save reading it again.
   */
  async check(manual: boolean, known?: PullRequest[]): Promise<void> {
    if (this.busy || !this.enabled) {
      if (manual && !this.enabled) {
        void vscode.window.showInformationMessage('Review notifications are turned off in the ReviewLens settings.');
      }
      return;
    }
    this.busy = true;
    try {
      const host = await this.deps.host();
      if (!host) {
        if (manual) {
          void vscode.window.showInformationMessage('Sign in to GitHub or GitLab in the ReviewLens panel first.');
        }
        return;
      }
      const project = `${host.kind}:${host.remote.host}/${host.remote.projectPath}`;
      if (project !== this.project) {
        this.project = project;
        this.checked.clear();
        this.unread.clear();
      }
      const me = await host.currentUser();
      if (!me) {
        return;
      }
      const list = known ?? (await host.listOpen());
      if (!known) {
        this.deps.onList(list);
      }
      const notes: Array<{ text: string; pr: PullRequest }> = [];

      // New review requests. The first check only records what's there, so old requests don't all pop up.
      const reqKey = `requests:${project}`;
      const before = this.store.getSeen(reqKey);
      const requested = list.filter((p) => p.reviewRequested);
      if (before) {
        for (const p of requested.filter((x) => !before.includes(String(x.number)))) {
          notes.push({ text: `@${p.author} asked for your review on #${p.number} “${p.title}”.`, pr: p });
          this.bump(p.number, 1);
        }
      }
      await this.store.setSeen(reqKey, requested.map((p) => String(p.number)));

      // Others' comments and reviews on your own pull/merge requests.
      const now = Date.now();
      for (const p of list.filter((x) => x.mine).slice(0, MAX_OWN_PRS)) {
        const last = this.checked.get(p.number);
        if (last && last.updatedAt === p.updatedAt && now - last.at < RECHECK_MS) {
          continue;
        }
        const [comments, info] = await Promise.all([host.comments(p), host.reviews(p)]);
        this.checked.set(p.number, { updatedAt: p.updatedAt, at: now });
        const items = activityItems(comments, info.reviews, me);
        const key = `activity:${project}#${p.number}`;
        const seen = this.store.getSeen(key);
        if (seen) {
          const fresh = unseen(items, seen);
          const onScreen = this.deps.current() === p.number && vscode.window.state.focused;
          if (fresh.length && !onScreen) {
            notes.push({ text: describeActivity(fresh, p), pr: p });
            this.bump(p.number, fresh.length);
          }
        }
        await this.store.setSeen(key, items.map((i) => i.id));
      }

      if (notes.length) {
        this.emitter.fire();
        this.show(notes, host);
      } else if (manual) {
        void vscode.window.showInformationMessage(`No new review activity on ${host.label}.`);
      }
    } catch (e) {
      if (manual) {
        void vscode.window.showErrorMessage(`Couldn't check for review activity. ${(e as Error).message}`);
      }
      // Background checks stay quiet; the next one tries again.
    } finally {
      this.busy = false;
    }
  }

  private show(notes: Array<{ text: string; pr: PullRequest }>, host: Host): void {
    const openHere = 'Open in ReviewLens';
    const openWeb = `Open on ${host.label}`;
    for (const n of notes.slice(0, 3)) {
      void vscode.window.showInformationMessage(n.text, openHere, openWeb).then((pick) => {
        if (pick === openHere) {
          void this.deps.open(n.pr.number);
        } else if (pick === openWeb && n.pr.url) {
          this.markRead(n.pr.number);
          void vscode.env.openExternal(vscode.Uri.parse(n.pr.url));
        }
      });
    }
    if (notes.length > 3) {
      const noun = host.kind === 'gitlab' ? 'merge requests' : 'pull requests';
      void vscode.window.showInformationMessage(`${notes.length - 3} more ${noun} have new review activity.`, openHere).then((pick) => {
        if (pick === openHere) {
          void this.deps.open(0);
        }
      });
    }
  }
}
