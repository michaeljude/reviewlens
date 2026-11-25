/*
 * Read-only clients for GitHub pull requests and GitLab merge requests.
 * No VS Code imports, so the response mapping can be unit tested.
 */
import { createHash } from 'crypto';
import { ChangeStatus } from './git';
import { HostKind, RemoteInfo } from './remote';

export interface PullRequest {
  /** PR number (GitHub) or MR iid (GitLab). */
  number: number;
  title: string;
  author: string;
  description: string;
  sourceBranch: string;
  targetBranch: string;
  url: string;
  draft: boolean;
  updatedAt: string;
  headSha: string;
  reviewRequested: boolean;
  mine: boolean;
}

export interface PrFile {
  path: string;
  oldPath?: string;
  status: ChangeStatus;
  added: number;
  deleted: number;
  /** Unified diff hunks; empty when the host didn't send them. */
  patch: string;
  binary: boolean;
  tooLarge: boolean;
}

export interface PrComment {
  id: string;
  threadId: string;
  path?: string;
  line?: number;
  author: string;
  body: string;
  createdAt: string;
  url?: string;
  resolved?: boolean;
  isReply: boolean;
}

export class HostError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

export interface Host {
  readonly kind: HostKind;
  readonly label: string;
  readonly remote: RemoteInfo;
  listOpen(): Promise<PullRequest[]>;
  files(pr: PullRequest): Promise<PrFile[]>;
  comments(pr: PullRequest): Promise<PrComment[]>;
  fileUrl(pr: PullRequest, path: string): string;
}

type Json = Record<string, unknown>;
type FetchFn = (url: string, init: { headers: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; headers: { get(name: string): string | null } }>;

const MAX_PAGES = 30;

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
function obj(v: unknown): Json {
  return v && typeof v === 'object' ? (v as Json) : {};
}

/** Counts added and removed lines in unified diff hunks. */
export function countDiffLines(patch: string): { added: number; deleted: number } {
  let added = 0;
  let deleted = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) {
      continue;
    }
    if (line.startsWith('+')) {
      added++;
    } else if (line.startsWith('-')) {
      deleted++;
    }
  }
  return { added, deleted };
}

// ---------- GitHub ----------

export function mapGithubPull(j: Json, me: string): PullRequest {
  const reviewers = Array.isArray(j.requested_reviewers) ? j.requested_reviewers.map((r) => str(obj(r).login).toLowerCase()) : [];
  const author = str(obj(j.user).login);
  return {
    number: num(j.number),
    title: str(j.title),
    author,
    description: str(j.body),
    sourceBranch: str(obj(j.head).ref),
    targetBranch: str(obj(j.base).ref),
    url: str(j.html_url),
    draft: j.draft === true,
    updatedAt: str(j.updated_at),
    headSha: str(obj(j.head).sha),
    reviewRequested: !!me && reviewers.includes(me.toLowerCase()),
    mine: !!me && author.toLowerCase() === me.toLowerCase(),
  };
}

const GITHUB_STATUS: Record<string, ChangeStatus> = {
  added: 'A',
  removed: 'D',
  modified: 'M',
  renamed: 'R',
  copied: 'A',
  changed: 'T',
  unchanged: 'M',
};

export function mapGithubFile(j: Json): PrFile {
  const patch = str(j.patch);
  const added = num(j.additions);
  const deleted = num(j.deletions);
  const hasChanges = added + deleted > 0;
  return {
    path: str(j.filename),
    oldPath: str(j.previous_filename) || undefined,
    status: GITHUB_STATUS[str(j.status)] ?? 'M',
    added,
    deleted,
    patch,
    // GitHub omits `patch` for binary files and for very large diffs.
    binary: !patch && !hasChanges,
    tooLarge: !patch && hasChanges,
  };
}

export function mapGithubComment(j: Json): PrComment {
  const id = String(num(j.id));
  const replyTo = num(j.in_reply_to_id);
  const line = num(j.line) || num(j.original_line) || undefined;
  return {
    id,
    threadId: replyTo ? String(replyTo) : id,
    path: str(j.path) || undefined,
    line,
    author: str(obj(j.user).login),
    body: str(j.body),
    createdAt: str(j.created_at),
    url: str(j.html_url) || undefined,
    isReply: !!replyTo,
  };
}

// ---------- GitLab ----------

export function mapGitlabMr(j: Json, me: string): PullRequest {
  const reviewers = Array.isArray(j.reviewers) ? j.reviewers.map((r) => str(obj(r).username).toLowerCase()) : [];
  const author = str(obj(j.author).username);
  return {
    number: num(j.iid),
    title: str(j.title),
    author,
    description: str(j.description),
    sourceBranch: str(j.source_branch),
    targetBranch: str(j.target_branch),
    url: str(j.web_url),
    draft: j.draft === true || j.work_in_progress === true,
    updatedAt: str(j.updated_at),
    headSha: str(j.sha),
    reviewRequested: !!me && reviewers.includes(me.toLowerCase()),
    mine: !!me && author.toLowerCase() === me.toLowerCase(),
  };
}

export function mapGitlabDiff(j: Json): PrFile {
  const patch = str(j.diff);
  const counts = countDiffLines(patch);
  const tooLarge = j.too_large === true || (j.collapsed === true && !patch);
  const status: ChangeStatus = j.new_file === true ? 'A' : j.deleted_file === true ? 'D' : j.renamed_file === true ? 'R' : 'M';
  // GitLab sends "Binary files … differ", or no text at all, for files it can't show as text.
  const binary = /^Binary files /m.test(patch) || (!patch && !tooLarge);
  return {
    path: str(j.new_path) || str(j.old_path),
    oldPath: j.renamed_file === true ? str(j.old_path) : undefined,
    status,
    added: binary ? 0 : counts.added,
    deleted: binary ? 0 : counts.deleted,
    patch: binary ? '' : patch,
    binary,
    tooLarge,
  };
}

export function mapGitlabDiscussions(list: unknown[], webUrl: string): PrComment[] {
  const out: PrComment[] = [];
  for (const d of list) {
    const disc = obj(d);
    const notes = Array.isArray(disc.notes) ? disc.notes.map(obj) : [];
    const threadId = str(disc.id);
    notes
      .filter((n) => n.system !== true)
      .forEach((n, i) => {
        const pos = obj(n.position);
        out.push({
          id: String(num(n.id)),
          threadId,
          path: str(pos.new_path) || str(pos.old_path) || undefined,
          line: num(pos.new_line) || num(pos.old_line) || undefined,
          author: str(obj(n.author).username),
          body: str(n.body),
          createdAt: str(n.created_at),
          url: webUrl ? `${webUrl}#note_${num(n.id)}` : undefined,
          resolved: n.resolvable === true ? n.resolved === true : undefined,
          isReply: i > 0,
        });
      });
  }
  return out;
}

// ---------- HTTP ----------

async function getJson(fetchFn: FetchFn, url: string, headers: Record<string, string>, what: string): Promise<{ data: unknown; next?: string }> {
  let res;
  try {
    res = await fetchFn(url, { headers });
  } catch (e) {
    throw new HostError(`Couldn't reach ${new URL(url).host}: ${(e as Error).message}`);
  }
  if (!res.ok) {
    const msg =
      res.status === 401
        ? 'Sign-in was rejected. Sign in again or update your token.'
        : res.status === 403
          ? 'Access denied, or the API rate limit was reached.'
          : res.status === 404
            ? `Not found. Check you have access to this repository.`
            : `Request failed (HTTP ${res.status}).`;
    throw new HostError(`${what}: ${msg}`, res.status);
  }
  const link = res.headers.get('link') ?? '';
  const next = /<([^>]+)>;\s*rel="next"/.exec(link)?.[1];
  return { data: await res.json(), next };
}

async function getAll(fetchFn: FetchFn, url: string, headers: Record<string, string>, what: string): Promise<unknown[]> {
  const all: unknown[] = [];
  let next: string | undefined = url;
  for (let i = 0; next && i < MAX_PAGES; i++) {
    const page: { data: unknown; next?: string } = await getJson(fetchFn, next, headers, what);
    if (!Array.isArray(page.data)) {
      break;
    }
    all.push(...page.data);
    next = page.next;
  }
  return all;
}

export class GitHubHost implements Host {
  readonly kind = 'github' as const;
  readonly label = 'GitHub';
  private me?: string;
  private readonly api = 'https://api.github.com';

  constructor(readonly remote: RemoteInfo, private readonly token: string, private readonly fetchFn: FetchFn) {}

  private headers(): Record<string, string> {
    return {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'ReviewLens',
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
    };
  }

  private repoUrl(): string {
    return `${this.api}/repos/${this.remote.projectPath}`;
  }

  private async login(): Promise<string> {
    if (this.me === undefined) {
      if (!this.token) {
        this.me = '';
      } else {
        const r = await getJson(this.fetchFn, `${this.api}/user`, this.headers(), 'GitHub user');
        this.me = str(obj(r.data).login);
      }
    }
    return this.me;
  }

  async listOpen(): Promise<PullRequest[]> {
    const me = await this.login();
    const r = await getJson(this.fetchFn, `${this.repoUrl()}/pulls?state=open&per_page=50&sort=updated&direction=desc`, this.headers(), 'Pull requests');
    return (Array.isArray(r.data) ? r.data : []).map((j) => mapGithubPull(obj(j), me));
  }

  async files(pr: PullRequest): Promise<PrFile[]> {
    const list = await getAll(this.fetchFn, `${this.repoUrl()}/pulls/${pr.number}/files?per_page=100`, this.headers(), 'Changed files');
    return list.map((j) => mapGithubFile(obj(j)));
  }

  async comments(pr: PullRequest): Promise<PrComment[]> {
    const list = await getAll(this.fetchFn, `${this.repoUrl()}/pulls/${pr.number}/comments?per_page=100`, this.headers(), 'Review comments');
    return list.map((j) => mapGithubComment(obj(j)));
  }

  fileUrl(pr: PullRequest, path: string): string {
    return `${pr.url}/files#diff-${sha256Hex(path)}`;
  }
}

export class GitLabHost implements Host {
  readonly kind = 'gitlab' as const;
  readonly label = 'GitLab';
  private me?: string;
  private readonly api: string;

  constructor(readonly remote: RemoteInfo, private readonly token: string, private readonly fetchFn: FetchFn) {
    this.api = `https://${remote.host}/api/v4`;
  }

  private headers(): Record<string, string> {
    return { Accept: 'application/json', ...(this.token ? { 'PRIVATE-TOKEN': this.token } : {}) };
  }

  private projectUrl(): string {
    return `${this.api}/projects/${encodeURIComponent(this.remote.projectPath)}`;
  }

  private async username(): Promise<string> {
    if (this.me === undefined) {
      if (!this.token) {
        this.me = '';
      } else {
        const r = await getJson(this.fetchFn, `${this.api}/user`, this.headers(), 'GitLab user');
        this.me = str(obj(r.data).username);
      }
    }
    return this.me;
  }

  async listOpen(): Promise<PullRequest[]> {
    const me = await this.username();
    const r = await getJson(this.fetchFn, `${this.projectUrl()}/merge_requests?state=opened&per_page=50&order_by=updated_at`, this.headers(), 'Merge requests');
    return (Array.isArray(r.data) ? r.data : []).map((j) => mapGitlabMr(obj(j), me));
  }

  async files(pr: PullRequest): Promise<PrFile[]> {
    try {
      const list = await getAll(this.fetchFn, `${this.projectUrl()}/merge_requests/${pr.number}/diffs?per_page=100`, this.headers(), 'Changed files');
      return list.map((j) => mapGitlabDiff(obj(j)));
    } catch (e) {
      // GitLab before 15.7 has no /diffs endpoint; fall back to /changes.
      if (!(e instanceof HostError) || e.status !== 404) {
        throw e;
      }
      const r = await getJson(this.fetchFn, `${this.projectUrl()}/merge_requests/${pr.number}/changes`, this.headers(), 'Changed files');
      const changes = obj(r.data).changes;
      return (Array.isArray(changes) ? changes : []).map((j) => mapGitlabDiff(obj(j)));
    }
  }

  async comments(pr: PullRequest): Promise<PrComment[]> {
    const list = await getAll(this.fetchFn, `${this.projectUrl()}/merge_requests/${pr.number}/discussions?per_page=100`, this.headers(), 'Discussions');
    return mapGitlabDiscussions(list, pr.url);
  }

  fileUrl(pr: PullRequest, _path: string): string {
    return `${pr.url}/diffs`;
  }
}

// GitHub anchors a file in the PR diff view by the SHA-256 of its path.
function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export function createHost(remote: RemoteInfo, token: string, fetchFn: FetchFn): Host {
  return remote.kind === 'github' ? new GitHubHost(remote, token, fetchFn) : new GitLabHost(remote, token, fetchFn);
}
