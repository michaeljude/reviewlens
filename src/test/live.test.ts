import { strict as assert } from 'assert';
import { test } from 'node:test';
import { activityItems, describeActivity, unseen } from '../activity';
import { groupThreads, parsePatch, rowFor } from '../diff';
import {
  apiMessage,
  FetchInit,
  GitHubHost,
  GitLabHost,
  githubReviewers,
  HostError,
  mapGithubComment,
  mapGithubPull,
  mapGithubReviews,
  mapGithubThreads,
  mapGitlabDiscussions,
  mapGitlabMr,
  mapGitlabReviews,
  PrComment,
} from '../hosts';
import { parseRemoteUrl } from '../remote';

test('numbers diff rows on the old and new side', () => {
  const rows = parsePatch('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -10,3 +10,4 @@ fn\n keep\n-old\n+new\n+more\n tail\n\\ No newline at end of file\n');
  assert.deepEqual(
    rows.map((r) => [r.k, r.o ?? null, r.n ?? null]),
    [
      ['meta', null, null],
      ['meta', null, null],
      ['meta', null, null],
      ['hunk', null, null],
      ['ctx', 10, 10],
      ['del', 11, null],
      ['add', null, 11],
      ['add', null, 12],
      ['ctx', 12, 13],
      ['meta', null, null],
    ],
  );
  assert.equal(rowFor(rows, 11, 'new'), 6);
  assert.equal(rowFor(rows, 11, 'old'), 5);
  assert.equal(rowFor(rows, 13, 'new'), 8);
  assert.equal(rowFor(rows, 99, 'new'), -1);
  assert.deepEqual(parsePatch(''), []);
});

function comment(p: Partial<PrComment>): PrComment {
  return { id: '1', threadId: '1', author: 'a', body: 'b', createdAt: '2026-01-01', resolvable: false, isReply: false, ...p };
}

test('groups comments into threads anchored to diff rows', () => {
  const rows = parsePatch('@@ -1,2 +1,2 @@\n-a\n+b\n c\n');
  const threads = groupThreads(
    [
      comment({ id: '3', threadId: '1', isReply: true, createdAt: '2026-01-02', body: 'reply' }),
      comment({ id: '1', threadId: '1', line: 1, side: 'new', resolvable: true, resolved: true }),
      comment({ id: '5', threadId: '5', line: 1, side: 'old' }),
      comment({ id: '7', threadId: '7', line: 40, side: 'new', outdated: true }),
    ],
    rows,
  );
  assert.deepEqual(
    threads.map((t) => [t.id, t.row, t.resolved, t.comments.map((c) => c.id)]),
    [
      ['5', 1, false, ['5']],
      ['1', 2, true, ['1', '3']],
      ['7', -1, false, ['7']],
    ],
  );
});

test('maps GitHub comment sides, outdated comments, threads and reviews', () => {
  const left = mapGithubComment({ id: 9, path: 'a.ts', line: 4, side: 'LEFT', user: { login: 'x' } });
  assert.deepEqual([left.side, left.outdated], ['old', false]);
  const old = mapGithubComment({ id: 10, path: 'a.ts', line: null, original_line: 7, side: 'RIGHT', user: { login: 'x' } });
  assert.deepEqual([old.line, old.side, old.outdated], [7, 'new', true]);

  const threads = mapGithubThreads([
    { id: 'PRRT_1', isResolved: true, comments: { nodes: [{ databaseId: 9 }] } },
    { id: 'PRRT_2', isResolved: false, comments: { nodes: [] } },
  ]);
  assert.deepEqual(threads.get('9'), { nodeId: 'PRRT_1', resolved: true });
  assert.equal(threads.size, 1);

  const reviews = mapGithubReviews([
    { id: 1, user: { login: 'ana' }, state: 'APPROVED', submitted_at: '2026-01-01T00:00:00Z' },
    { id: 2, user: { login: 'ana' }, state: 'COMMENTED', submitted_at: '2026-01-02T00:00:00Z' },
    { id: 3, user: { login: 'bo' }, state: 'CHANGES_REQUESTED', submitted_at: '2026-01-01T00:00:00Z' },
    { id: 4, user: { login: 'bo' }, state: 'PENDING' },
    { id: 5, user: { login: 'me' }, state: 'COMMENTED', submitted_at: '2026-01-01T00:00:00Z' },
  ]);
  assert.equal(reviews.length, 4);
  assert.deepEqual(githubReviewers(reviews, ['cy'], 'me'), [
    { user: 'bo', state: 'changes' },
    { user: 'ana', state: 'approved' },
    { user: 'cy', state: 'pending' },
  ]);
  // Re-requesting a review puts the reviewer back to waiting.
  assert.deepEqual(githubReviewers(reviews, ['ana'], 'me')[1], { user: 'ana', state: 'pending' });

  const pr = mapGithubPull({ number: 1, state: 'closed', merged_at: '2026-01-01', user: { login: 'me' }, head: {}, base: {} }, 'me');
  assert.equal(pr.state, 'merged');
});

test('maps GitLab reviewers, approvals and resolvable discussions', () => {
  const info = mapGitlabReviews(
    { approved_by: [{ user: { username: 'ana' } }] },
    [
      { user: { username: 'ana' }, state: 'unreviewed' },
      { user: { username: 'bo' }, state: 'requested_changes', created_at: 't' },
      { user: { username: 'cy' }, state: 'unreviewed' },
      { user: { username: 'me' }, state: 'unreviewed' },
    ],
    'me',
  );
  assert.deepEqual(info.reviewers, [
    { user: 'bo', state: 'changes' },
    { user: 'ana', state: 'approved' },
    { user: 'cy', state: 'pending' },
  ]);
  assert.deepEqual(info.reviews.map((r) => r.id).sort(), ['approved:ana', 'changes:bo:t']);

  const c = mapGitlabDiscussions(
    [
      {
        id: 'd1',
        notes: [
          { id: 1, body: 'x', author: { username: 'a' }, position: { new_path: 'f', old_line: 3 }, resolvable: true, resolved: true },
          { id: 2, body: 'y', author: { username: 'b' }, resolvable: true, resolved: true },
        ],
      },
    ],
    '',
  );
  assert.deepEqual([c[0].side, c[0].resolved, c[0].resolveId, c[1].resolved], ['old', true, 'd1', true]);
  assert.equal(mapGitlabMr({ iid: 1, state: 'merged' }, '').state, 'merged');
});

test('reads error text from GitHub and GitLab error bodies', () => {
  assert.equal(apiMessage({ message: 'Validation Failed', errors: [{ message: 'line must be part of the diff' }] }), 'Validation Failed. line must be part of the diff');
  assert.equal(apiMessage({ message: { base: ['is invalid'] } }), 'base is invalid');
  assert.equal(apiMessage({ error: 'insufficient_scope' }), 'insufficient_scope');
  assert.equal(apiMessage(null), '');
});

type Call = { method: string; url: string; body?: unknown };
function recorder(routes: Record<string, { status?: number; body?: unknown }>, calls: Call[]) {
  return async (url: string, init: FetchInit) => {
    const method = init.method ?? 'GET';
    calls.push({ method, url, body: init.body ? JSON.parse(init.body) : undefined });
    const r = routes[`${method} ${url}`];
    const status = r ? (r.status ?? 200) : 404;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => (r?.body ?? {}),
      headers: { get: () => null },
    };
  };
}

test('GitHub client posts comments, replies, resolutions and reviews', async () => {
  const api = 'https://api.github.com';
  const repo = `${api}/repos/o/r`;
  const calls: Call[] = [];
  const host = new GitHubHost(
    parseRemoteUrl('https://github.com/o/r')!,
    'T',
    recorder(
      {
        [`POST ${repo}/pulls/4/comments`]: { status: 201 },
        [`POST ${repo}/pulls/4/comments/77/replies`]: { status: 201 },
        [`POST ${api}/graphql`]: { body: { data: {} } },
        [`POST ${repo}/pulls/4/reviews`]: { body: { id: 1 } },
      },
      calls,
    ),
  );
  const pr = mapGithubPull({ number: 4, head: { sha: 'HEAD' }, base: {}, user: { login: 'x' } }, 'me');
  await host.addComment(pr, { path: 'a.ts', newLine: 12, oldLine: 10 }, 'Nice');
  await host.addComment(pr, { path: 'a.ts', oldLine: 3 }, 'Why removed?');
  await host.reply(pr, '77', 'Done');
  await host.setResolved(pr, { ...mapGithubComment({ id: 77 }), resolvable: true, resolveId: 'PRRT_x' }, true);
  await host.submitReview(pr, 'changes', 'Please fix');
  assert.deepEqual(calls[0].body, { body: 'Nice', commit_id: 'HEAD', path: 'a.ts', line: 12, side: 'RIGHT' });
  assert.deepEqual(calls[1].body, { body: 'Why removed?', commit_id: 'HEAD', path: 'a.ts', line: 3, side: 'LEFT' });
  assert.equal(calls[2].url, `${repo}/pulls/4/comments/77/replies`);
  assert.match(JSON.stringify(calls[3].body), /resolveReviewThread/);
  assert.deepEqual(calls[4].body, { commit_id: 'HEAD', event: 'REQUEST_CHANGES', body: 'Please fix' });

  const denied = new GitHubHost(parseRemoteUrl('https://github.com/o/r')!, 'T', recorder({ [`POST ${repo}/pulls/4/reviews`]: { status: 403 } }, []));
  await assert.rejects(() => denied.submitReview(pr, 'approve', ''), (e: unknown) => e instanceof HostError && e.status === 403 && /read access/.test(e.message));
  const invalid = new GitHubHost(
    parseRemoteUrl('https://github.com/o/r')!,
    'T',
    recorder({ [`POST ${repo}/pulls/4/reviews`]: { status: 422, body: { message: 'Unprocessable Entity', errors: ['Can not approve your own pull request'] } } }, []),
  );
  await assert.rejects(() => invalid.submitReview(pr, 'approve', ''), /Can not approve your own pull request/);
});

test('GitHub comments carry resolution state from review threads', async () => {
  const api = 'https://api.github.com';
  const host = new GitHubHost(
    parseRemoteUrl('https://github.com/o/r')!,
    'T',
    recorder(
      {
        [`GET ${api}/repos/o/r/pulls/4/comments?per_page=100`]: { body: [{ id: 5, path: 'a', line: 1, user: { login: 'x' } }, { id: 6, in_reply_to_id: 5, path: 'a', line: 1, user: { login: 'y' } }] },
        [`POST ${api}/graphql`]: {
          body: { data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [{ id: 'PRRT_5', isResolved: true, comments: { nodes: [{ databaseId: 5 }] } }] } } } } },
        },
      },
      [],
    ),
  );
  const pr = mapGithubPull({ number: 4, head: {}, base: {}, user: {} }, '');
  const comments = await host.comments(pr);
  assert.deepEqual(comments.map((c) => [c.resolved, c.resolveId]), [
    [true, 'PRRT_5'],
    [true, 'PRRT_5'],
  ]);
});

test('GitLab client posts positioned comments, approvals and change requests', async () => {
  const base = 'https://gitlab.com/api/v4/projects/g%2Fp/merge_requests/3';
  const calls: Call[] = [];
  const host = new GitLabHost(
    parseRemoteUrl('https://gitlab.com/g/p')!,
    'T',
    recorder(
      {
        ['GET https://gitlab.com/api/v4/user']: { body: { username: 'me' } },
        [`GET ${base}`]: { body: { iid: 3, sha: 'H', diff_refs: { base_sha: 'B', start_sha: 'S', head_sha: 'H' } } },
        [`POST ${base}/discussions`]: { status: 201 },
        [`PUT ${base}/discussions/d1`]: {},
        [`POST ${base}/approve`]: { status: 201 },
        [`POST ${base}/notes`]: { status: 201 },
      },
      calls,
    ),
  );
  const pr = mapGitlabMr({ iid: 3, sha: 'H' }, '');
  await host.addComment(pr, { path: 'new.ts', oldPath: 'old.ts', oldLine: 4, newLine: 5 }, 'Hmm');
  const post = calls.find((c) => c.url === `${base}/discussions`);
  assert.deepEqual(post?.body, {
    body: 'Hmm',
    position: { position_type: 'text', base_sha: 'B', start_sha: 'S', head_sha: 'H', old_path: 'old.ts', new_path: 'new.ts', old_line: 4, new_line: 5 },
  });
  await host.setResolved(pr, { ...mapGitlabDiscussions([{ id: 'd1', notes: [{ id: 1, resolvable: true }] }], '')[0] }, true);
  assert.deepEqual(calls[calls.length - 1], { method: 'PUT', url: `${base}/discussions/d1`, body: { resolved: true } });

  calls.length = 0;
  await host.submitReview(pr, 'approve', '');
  assert.deepEqual(calls, [{ method: 'POST', url: `${base}/approve`, body: { sha: 'H' } }]);

  calls.length = 0;
  // Not approved before: GitLab answers 404 to unapprove, which is fine.
  await host.submitReview(pr, 'changes', 'Fix the test');
  assert.deepEqual(
    calls.map((c) => [c.method, c.url.slice(base.length)]),
    [
      ['POST', '/unapprove'],
      ['POST', '/notes'],
    ],
  );
});

test('finds new activity from others and describes it', () => {
  const items = activityItems(
    [comment({ id: '1', author: 'ana', body: 'Please rename this variable' }), comment({ id: '2', author: 'Me', body: 'ok' })],
    [
      { id: '10', author: 'bo', state: 'approved', body: '', at: 't' },
      { id: '11', author: 'cy', state: 'commented', body: '', at: 't' },
      { id: '12', author: 'me', state: 'approved', body: '', at: 't' },
    ],
    'me',
  );
  assert.deepEqual(items.map((i) => i.id), ['c:1', 'r:10']);
  assert.deepEqual(unseen(items, ['c:1']).map((i) => i.id), ['r:10']);
  const pr = { number: 12, title: 'Add cancel' };
  assert.equal(describeActivity([items[0]], pr), '@ana commented on #12 “Add cancel”: “Please rename this variable”');
  assert.equal(describeActivity(items, pr), '@bo approved #12 “Add cancel”; @ana left a comment.');
  assert.equal(
    describeActivity([{ id: 'r:1', kind: 'changes', author: 'cy', body: '' }, ...items], pr),
    '@cy requested changes on #12 “Add cancel”; @bo approved; @ana left a comment.',
  );
});
