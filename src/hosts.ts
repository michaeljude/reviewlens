/*
 * Clients for GitHub pull requests and GitLab merge requests: reading changes, comments and reviews,
 * and posting comments, replies, thread resolutions and reviews.
 * No VS Code imports, so the request and response mapping can be unit tested.
 */
import { createHash } from 'crypto';
import { ChangeStatus } from './git';
import { HostKind, RemoteInfo } from './remote';

export type PrState = 'open' | 'closed' | 'merged';

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
  state: PrState;
  /** Usernames whose review is requested (GitHub: still waiting; GitLab: all assigned reviewers). */
  reviewers: string[];
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

/** Which side of the diff a line comment is on: the old file (removed lines) or the new file. */
export type Side = 'old' | 'new';

export interface PrComment {
  id: string;
  threadId: string;
  path?: string;
  line?: number;
  side?: Side;
  /** The code the comment was written on has changed since (GitHub). */
  outdated?: boolean;
  author: string;
  body: string;
  createdAt: string;
  url?: string;
  resolved?: boolean;
  /** The thread can be resolved and reopened. */
  resolvable: boolean;
  /** Id used to resolve the thread: GitHub's GraphQL thread id, GitLab's discussion id. */
  resolveId?: string;
  isReply: boolean;
}

export type ReviewState = 'approved' | 'changes' | 'commented' | 'dismissed' | 'pending';

/** One submitted review (GitHub) or one reviewer's current state (GitLab). */
export interface PrReview {
  id: string;
  author: string;
  state: ReviewState;
  body: string;
  at: string;
}

/** Where each reviewer stands now. */
export interface ReviewerStatus {
  user: string;
  state: 'approved' | 'changes' | 'commented' | 'pending';
}

export interface ReviewInfo {
  reviews: PrReview[];
  reviewers: ReviewerStatus[];
}

/** A diff line to comment on. A context line has both numbers, an added line only `newLine`, a removed line only `oldLine`. */
export interface CommentTarget {
  path: string;
  oldPath?: string;
  oldLine?: number;
  newLine?: number;
}

export type ReviewEvent = 'approve' | 'changes' | 'comment';

export class HostError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface Host {
  readonly kind: HostKind;
  readonly label: string;
  readonly remote: RemoteInfo;
  /** GitHub doesn't let authors approve their own pull request. */
  readonly canApproveOwn: boolean;
  currentUser(): Promise<string>;
  listOpen(): Promise<PullRequest[]>;
  /** Re-reads one pull/merge request, for its latest head commit and state. */
  pull(num: number): Promise<PullRequest>;
  files(pr: PullRequest): Promise<PrFile[]>;
  comments(pr: PullRequest): Promise<PrComment[]>;
  reviews(pr: PullRequest): Promise<ReviewInfo>;
  addComment(pr: PullRequest, target: CommentTarget, body: string): Promise<void>;
  reply(pr: PullRequest, threadId: string, body: string): Promise<void>;
  setResolved(pr: PullRequest, root: PrComment, resolved: boolean): Promise<void>;
  submitReview(pr: PullRequest, event: ReviewEvent, body: string): Promise<void>;
  fileUrl(pr: PullRequest, path: string): string;
}

type Json = Record<string, unknown>;
export interface FetchInit {
  method?: string;
  headers: Record<string, string>;
  body?: string;
}
export type FetchFn = (
  url: string,
  init: FetchInit,
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; headers: { get(name: string): string | null } }>;

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
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
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

/** Orders reviewers: changes requested first, then approved, commented and waiting. */
function sortReviewers(list: ReviewerStatus[]): ReviewerStatus[] {
  const rank = { changes: 0, approved: 1, commented: 2, pending: 3 };
  return list.sort((a, b) => rank[a.state] - rank[b.state] || a.user.localeCompare(b.user));
}

// ---------- GitHub ----------

export function mapGithubPull(j: Json, me: string): PullRequest {
  const reviewers = arr(j.requested_reviewers).map((r) => str(obj(r).login));
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
    state: j.merged === true || !!j.merged_at ? 'merged' : j.state === 'closed' ? 'closed' : 'open',
    reviewers,
    reviewRequested: !!me && reviewers.some((r) => r.toLowerCase() === me.toLowerCase()),
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
  const current = num(j.line);
  const line = current || num(j.original_line) || undefined;
  return {
    id,
    threadId: replyTo ? String(replyTo) : id,
    path: str(j.path) || undefined,
    line,
    side: line ? (j.side === 'LEFT' ? 'old' : 'new') : undefined,
    outdated: !!line && !current,
    author: str(obj(j.user).login),
    body: str(j.body),
    createdAt: str(j.created_at),
    url: str(j.html_url) || undefined,
    resolvable: false,
    isReply: !!replyTo,
  };
}

const GITHUB_REVIEW: Record<string, ReviewState> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes',
  COMMENTED: 'commented',
  DISMISSED: 'dismissed',
};

/** Maps submitted reviews; drafts (PENDING) are left out. */
export function mapGithubReviews(list: unknown[]): PrReview[] {
  const out: PrReview[] = [];
  for (const r of list.map(obj)) {
    const state = GITHUB_REVIEW[str(r.state)];
    if (state) {
      out.push({ id: String(num(r.id)), author: str(obj(r.user).login), state, body: str(r.body), at: str(r.submitted_at) });
    }
  }
  return out;
}

/**
 * Each reviewer's current state, the way GitHub shows it: the latest approval, change request or dismissal counts;
 * a comment-only review doesn't replace it; a reviewer whose review is requested again is waiting.
 */
export function githubReviewers(reviews: PrReview[], requested: string[], author: string): ReviewerStatus[] {
  const state = new Map<string, ReviewerStatus['state']>();
  const sorted = [...reviews].sort((a, b) => a.at.localeCompare(b.at));
  for (const r of sorted) {
    if (r.author.toLowerCase() === author.toLowerCase()) {
      continue;
    }
    if (r.state === 'approved' || r.state === 'changes') {
      state.set(r.author, r.state);
    } else if (r.state === 'dismissed') {
      state.set(r.author, 'commented');
    } else if (!state.has(r.author)) {
      state.set(r.author, 'commented');
    }
  }
  for (const u of requested) {
    state.set(u, 'pending');
  }
  return sortReviewers([...state.entries()].map(([user, s]) => ({ user, state: s })));
}

/** Maps GraphQL review threads to their resolution state, by the database id of each thread's first comment. */
export function mapGithubThreads(nodes: unknown[]): Map<string, { nodeId: string; resolved: boolean }> {
  const out = new Map<string, { nodeId: string; resolved: boolean }>();
  for (const n of nodes.map(obj)) {
    const first = obj(arr(obj(n.comments).nodes)[0]);
    const dbId = num(first.databaseId);
    if (dbId && str(n.id)) {
      out.set(String(dbId), { nodeId: str(n.id), resolved: n.isResolved === true });
    }
  }
  return out;
}

// ---------- GitLab ----------

export function mapGitlabMr(j: Json, me: string): PullRequest {
  const reviewers = arr(j.reviewers).map((r) => str(obj(r).username));
  const author = str(obj(j.author).username);
  const st = str(j.state);
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
    state: st === 'merged' ? 'merged' : st === 'closed' || st === 'locked' ? 'closed' : 'open',
    reviewers,
    reviewRequested: !!me && reviewers.some((r) => r.toLowerCase() === me.toLowerCase()),
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
    const notes = arr(disc.notes).map(obj);
    const threadId = str(disc.id);
    const resolvable = notes.some((n) => n.resolvable === true);
    const resolved = resolvable ? notes.filter((n) => n.resolvable === true).every((n) => n.resolved === true) : undefined;
    notes
      .filter((n) => n.system !== true)
      .forEach((n, i) => {
        const pos = obj(n.position);
        const newLine = num(pos.new_line);
        const oldLine = num(pos.old_line);
        out.push({
          id: String(num(n.id)),
          threadId,
          path: str(pos.new_path) || str(pos.old_path) || undefined,
          line: newLine || oldLine || undefined,
          side: newLine ? 'new' : oldLine ? 'old' : undefined,
          author: str(obj(n.author).username),
          body: str(n.body),
          createdAt: str(n.created_at),
          url: webUrl ? `${webUrl}#note_${num(n.id)}` : undefined,
          resolved,
          resolvable,
          resolveId: resolvable ? threadId : undefined,
          isReply: i > 0,
        });
      });
  }
  return out;
}

/** Turns GitLab approvals and reviewer states into reviews (for activity) and reviewer statuses. */
export function mapGitlabReviews(approvals: Json, reviewerList: unknown[], author: string): ReviewInfo {
  const reviews: PrReview[] = [];
  const state = new Map<string, ReviewerStatus['state']>();
  for (const r of reviewerList.map(obj)) {
    const user = str(obj(r.user).username);
    const s = str(r.state);
    if (!user) {
      continue;
    }
    if (s === 'requested_changes') {
      state.set(user, 'changes');
      reviews.push({ id: `changes:${user}:${str(r.created_at)}`, author: user, state: 'changes', body: '', at: str(r.created_at) });
    } else if (s === 'reviewed') {
      state.set(user, 'commented');
    } else {
      state.set(user, 'pending');
    }
  }
  for (const a of arr(approvals.approved_by).map(obj)) {
    const user = str(obj(a.user).username);
    if (user) {
      state.set(user, 'approved');
      reviews.push({ id: `approved:${user}`, author: user, state: 'approved', body: '', at: str(a.approved_at) });
    }
  }
  state.delete(author);
  return { reviews, reviewers: sortReviewers([...state.entries()].map(([user, s]) => ({ user, state: s }))) };
}

// ---------- HTTP ----------

/** The most useful text from an API error body: GitHub's `message` and `errors`, GitLab's `message` or `error`. */
export function apiMessage(data: unknown): string {
  const d = obj(data);
  const parts: string[] = [];
  const m = d.message;
  if (typeof m === 'string') {
    parts.push(m);
  } else if (Array.isArray(m)) {
    parts.push(m.map(String).join(' '));
  } else if (m && typeof m === 'object') {
    parts.push(
      Object.entries(m as Json)
        .map(([k, v]) => `${k} ${Array.isArray(v) ? v.join(', ') : String(v)}`)
        .join('; '),
    );
  }
  if (typeof d.error === 'string') {
    parts.push(d.error);
  }
  for (const e of arr(d.errors)) {
    const text = typeof e === 'string' ? e : str(obj(e).message);
    if (text) {
      parts.push(text);
    }
  }
  return parts.filter((p) => p.trim()).join('. ');
}

async function request(fetchFn: FetchFn, method: string, url: string, headers: Record<string, string>, what: string, body?: unknown): Promise<{ data: unknown; next?: string }> {
  let res;
  const init: FetchInit = { method, headers: body === undefined ? headers : { ...headers, 'Content-Type': 'application/json' } };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  try {
    res = await fetchFn(url, init);
  } catch (e) {
    throw new HostError(`Couldn't reach ${new URL(url).host}: ${(e as Error).message}`);
  }
  let data: unknown = {};
  try {
    data = await res.json();
  } catch {
    // Empty or non-JSON body (for example 204 No Content).
  }
  if (!res.ok) {
    const write = method !== 'GET';
    const detail = apiMessage(data);
    const msg =
      res.status === 401
        ? 'Sign-in was rejected. Sign in again or update your token.'
        : res.status === 403
          ? write
            ? 'Not allowed. Your sign-in or token may only have read access (GitHub: Pull requests read and write; GitLab: the api scope), or the API rate limit was reached.'
            : 'Access denied, or the API rate limit was reached.'
          : res.status === 404
            ? `Not found. Check you have access to this repository.`
            : detail || `Request failed (HTTP ${res.status}).`;
    throw new HostError(`${what}: ${msg}`, res.status);
  }
  const link = res.headers.get('link') ?? '';
  const next = /<([^>]+)>;\s*rel="next"/.exec(link)?.[1];
  return { data, next };
}

async function getAll(fetchFn: FetchFn, url: string, headers: Record<string, string>, what: string): Promise<unknown[]> {
  const all: unknown[] = [];
  let next: string | undefined = url;
  for (let i = 0; next && i < MAX_PAGES; i++) {
    const page: { data: unknown; next?: string } = await request(fetchFn, 'GET', next, headers, what);
    if (!Array.isArray(page.data)) {
      break;
    }
    all.push(...page.data);
    next = page.next;
  }
  return all;
}

const THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { id isResolved comments(first: 1) { nodes { databaseId } } }
      }
    }
  }
}`;

export class GitHubHost implements Host {
  readonly kind = 'github' as const;
  readonly label = 'GitHub';
  readonly canApproveOwn = false;
  private me?: string;
  private readonly api = 'https://api.github.com';

  constructor(
    readonly remote: RemoteInfo,
    private readonly token: string,
    private readonly fetchFn: FetchFn,
  ) {}

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

  private send(method: string, url: string, what: string, body?: unknown) {
    return request(this.fetchFn, method, url, this.headers(), what, body);
  }

  private async graphql(query: string, variables: Json, what: string): Promise<Json> {
    const r = await this.send('POST', `${this.api}/graphql`, what, { query, variables });
    const errors = arr(obj(r.data).errors);
    if (errors.length) {
      throw new HostError(`${what}: ${errors.map((e) => str(obj(e).message)).filter(Boolean).join('. ') || 'GraphQL request failed.'}`);
    }
    return obj(obj(r.data).data);
  }

  async currentUser(): Promise<string> {
    if (this.me === undefined) {
      if (!this.token) {
        this.me = '';
      } else {
        const r = await this.send('GET', `${this.api}/user`, 'GitHub user');
        this.me = str(obj(r.data).login);
      }
    }
    return this.me;
  }

  async listOpen(): Promise<PullRequest[]> {
    const me = await this.currentUser();
    const r = await this.send('GET', `${this.repoUrl()}/pulls?state=open&per_page=50&sort=updated&direction=desc`, 'Pull requests');
    return arr(r.data).map((j) => mapGithubPull(obj(j), me));
  }

  async pull(n: number): Promise<PullRequest> {
    const me = await this.currentUser();
    const r = await this.send('GET', `${this.repoUrl()}/pulls/${n}`, 'Pull request');
    return mapGithubPull(obj(r.data), me);
  }

  async files(pr: PullRequest): Promise<PrFile[]> {
    const list = await getAll(this.fetchFn, `${this.repoUrl()}/pulls/${pr.number}/files?per_page=100`, this.headers(), 'Changed files');
    return list.map((j) => mapGithubFile(obj(j)));
  }

  /** Review threads' resolution state. Only GraphQL has it. */
  private async threads(pr: PullRequest): Promise<Map<string, { nodeId: string; resolved: boolean }>> {
    const [owner, ...rest] = this.remote.projectPath.split('/');
    const all: unknown[] = [];
    let after: string | null = null;
    for (let i = 0; i < 10; i++) {
      const d = await this.graphql(THREADS_QUERY, { owner, name: rest.join('/'), number: pr.number, after }, 'Review threads');
      const rt = obj(obj(obj(d.repository).pullRequest).reviewThreads);
      all.push(...arr(rt.nodes));
      const page = obj(rt.pageInfo);
      if (page.hasNextPage !== true) {
        break;
      }
      after = str(page.endCursor) || null;
    }
    return mapGithubThreads(all);
  }

  async comments(pr: PullRequest): Promise<PrComment[]> {
    const [list, threads] = await Promise.all([
      getAll(this.fetchFn, `${this.repoUrl()}/pulls/${pr.number}/comments?per_page=100`, this.headers(), 'Review comments'),
      // Resolution state is a nice-to-have; comments still show without it.
      this.threads(pr).catch(() => new Map<string, { nodeId: string; resolved: boolean }>()),
    ]);
    return list.map((j) => {
      const c = mapGithubComment(obj(j));
      const t = threads.get(c.threadId);
      if (t) {
        c.resolved = t.resolved;
        c.resolvable = true;
        c.resolveId = t.nodeId;
      }
      return c;
    });
  }

  async reviews(pr: PullRequest): Promise<ReviewInfo> {
    const list = await getAll(this.fetchFn, `${this.repoUrl()}/pulls/${pr.number}/reviews?per_page=100`, this.headers(), 'Reviews');
    const reviews = mapGithubReviews(list);
    return { reviews, reviewers: githubReviewers(reviews, pr.reviewers, pr.author) };
  }

  async addComment(pr: PullRequest, t: CommentTarget, body: string): Promise<void> {
    const onNew = t.newLine !== undefined;
    await this.send('POST', `${this.repoUrl()}/pulls/${pr.number}/comments`, 'Comment', {
      body,
      commit_id: pr.headSha,
      path: t.path,
      line: onNew ? t.newLine : t.oldLine,
      side: onNew ? 'RIGHT' : 'LEFT',
    });
  }

  async reply(pr: PullRequest, threadId: string, body: string): Promise<void> {
    await this.send('POST', `${this.repoUrl()}/pulls/${pr.number}/comments/${encodeURIComponent(threadId)}/replies`, 'Reply', { body });
  }

  async setResolved(_pr: PullRequest, root: PrComment, resolved: boolean): Promise<void> {
    if (!root.resolveId) {
      throw new HostError('This thread can’t be resolved from the editor.');
    }
    const mutation = resolved
      ? 'mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { isResolved } } }'
      : 'mutation($id: ID!) { unresolveReviewThread(input: { threadId: $id }) { thread { isResolved } } }';
    await this.graphql(mutation, { id: root.resolveId }, resolved ? 'Resolve thread' : 'Reopen thread');
  }

  async submitReview(pr: PullRequest, event: ReviewEvent, body: string): Promise<void> {
    const ev = event === 'approve' ? 'APPROVE' : event === 'changes' ? 'REQUEST_CHANGES' : 'COMMENT';
    await this.send('POST', `${this.repoUrl()}/pulls/${pr.number}/reviews`, 'Review', {
      commit_id: pr.headSha || undefined,
      event: ev,
      ...(body ? { body } : {}),
    });
  }

  fileUrl(pr: PullRequest, path: string): string {
    return `${pr.url}/files#diff-${sha256Hex(path)}`;
  }
}

export class GitLabHost implements Host {
  readonly kind = 'gitlab' as const;
  readonly label = 'GitLab';
  readonly canApproveOwn = true;
  private me?: string;
  private readonly api: string;
  private readonly diffRefs = new Map<string, Json>();

  constructor(
    readonly remote: RemoteInfo,
    private readonly token: string,
    private readonly fetchFn: FetchFn,
  ) {
    this.api = `https://${remote.host}/api/v4`;
  }

  private headers(): Record<string, string> {
    return { Accept: 'application/json', ...(this.token ? { 'PRIVATE-TOKEN': this.token } : {}) };
  }

  private projectUrl(): string {
    return `${this.api}/projects/${encodeURIComponent(this.remote.projectPath)}`;
  }

  private mrUrl(pr: PullRequest | number): string {
    return `${this.projectUrl()}/merge_requests/${typeof pr === 'number' ? pr : pr.number}`;
  }

  private send(method: string, url: string, what: string, body?: unknown) {
    return request(this.fetchFn, method, url, this.headers(), what, body);
  }

  async currentUser(): Promise<string> {
    if (this.me === undefined) {
      if (!this.token) {
        this.me = '';
      } else {
        const r = await this.send('GET', `${this.api}/user`, 'GitLab user');
        this.me = str(obj(r.data).username);
      }
    }
    return this.me;
  }

  async listOpen(): Promise<PullRequest[]> {
    const me = await this.currentUser();
    const r = await this.send('GET', `${this.projectUrl()}/merge_requests?state=opened&per_page=50&order_by=updated_at`, 'Merge requests');
    return arr(r.data).map((j) => mapGitlabMr(obj(j), me));
  }

  async pull(n: number): Promise<PullRequest> {
    const me = await this.currentUser();
    const r = await this.send('GET', this.mrUrl(n), 'Merge request');
    const j = obj(r.data);
    const pr = mapGitlabMr(j, me);
    if (j.diff_refs) {
      this.diffRefs.set(`${n}@${pr.headSha}`, obj(j.diff_refs));
    }
    return pr;
  }

  async files(pr: PullRequest): Promise<PrFile[]> {
    try {
      const list = await getAll(this.fetchFn, `${this.mrUrl(pr)}/diffs?per_page=100`, this.headers(), 'Changed files');
      return list.map((j) => mapGitlabDiff(obj(j)));
    } catch (e) {
      // GitLab before 15.7 has no /diffs endpoint; fall back to /changes.
      if (!(e instanceof HostError) || e.status !== 404) {
        throw e;
      }
      const r = await this.send('GET', `${this.mrUrl(pr)}/changes`, 'Changed files');
      return arr(obj(r.data).changes).map((j) => mapGitlabDiff(obj(j)));
    }
  }

  async comments(pr: PullRequest): Promise<PrComment[]> {
    const list = await getAll(this.fetchFn, `${this.mrUrl(pr)}/discussions?per_page=100`, this.headers(), 'Discussions');
    return mapGitlabDiscussions(list, pr.url);
  }

  async reviews(pr: PullRequest): Promise<ReviewInfo> {
    const [approvals, reviewers] = await Promise.all([
      this.send('GET', `${this.mrUrl(pr)}/approvals`, 'Approvals').then((r) => obj(r.data)),
      // The reviewers endpoint (with review states) needs a recent GitLab; approvals alone still work.
      getAll(this.fetchFn, `${this.mrUrl(pr)}/reviewers`, this.headers(), 'Reviewers').catch(() =>
        pr.reviewers.map((u) => ({ user: { username: u }, state: 'unreviewed' })),
      ),
    ]);
    return mapGitlabReviews(approvals, reviewers, pr.author);
  }

  private async refs(pr: PullRequest): Promise<Json> {
    const key = `${pr.number}@${pr.headSha}`;
    if (!this.diffRefs.has(key)) {
      await this.pull(pr.number);
    }
    const refs = this.diffRefs.get(key) ?? [...this.diffRefs.entries()].reverse().find(([k]) => k.startsWith(`${pr.number}@`))?.[1];
    if (!refs) {
      throw new HostError('Comment: GitLab didn’t send the merge request’s diff versions. Reload it and try again.');
    }
    return refs;
  }

  async addComment(pr: PullRequest, t: CommentTarget, body: string): Promise<void> {
    const refs = await this.refs(pr);
    await this.send('POST', `${this.mrUrl(pr)}/discussions`, 'Comment', {
      body,
      position: {
        position_type: 'text',
        base_sha: str(refs.base_sha),
        start_sha: str(refs.start_sha),
        head_sha: str(refs.head_sha),
        old_path: t.oldPath ?? t.path,
        new_path: t.path,
        ...(t.oldLine !== undefined ? { old_line: t.oldLine } : {}),
        ...(t.newLine !== undefined ? { new_line: t.newLine } : {}),
      },
    });
  }

  async reply(pr: PullRequest, threadId: string, body: string): Promise<void> {
    await this.send('POST', `${this.mrUrl(pr)}/discussions/${encodeURIComponent(threadId)}/notes`, 'Reply', { body });
  }

  async setResolved(pr: PullRequest, root: PrComment, resolved: boolean): Promise<void> {
    const id = root.resolveId ?? root.threadId;
    await this.send('PUT', `${this.mrUrl(pr)}/discussions/${encodeURIComponent(id)}`, resolved ? 'Resolve thread' : 'Reopen thread', { resolved });
  }

  async submitReview(pr: PullRequest, event: ReviewEvent, body: string): Promise<void> {
    if (event === 'approve') {
      // `sha` makes GitLab refuse the approval if new commits arrived since the review was loaded.
      await this.send('POST', `${this.mrUrl(pr)}/approve`, 'Approve', pr.headSha ? { sha: pr.headSha } : {});
    }
    if (event === 'changes') {
      // GitLab's REST API has no "request changes" call: remove your approval (if any) and leave the comment.
      await this.send('POST', `${this.mrUrl(pr)}/unapprove`, 'Remove approval', {}).catch((e) => {
        if (!(e instanceof HostError) || e.status !== 404) {
          throw e;
        }
      });
    }
    if (body) {
      await this.send('POST', `${this.mrUrl(pr)}/notes`, 'Comment', { body });
    }
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
