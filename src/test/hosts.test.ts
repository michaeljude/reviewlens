import { strict as assert } from 'assert';
import { test } from 'node:test';
import {
  countDiffLines,
  GitHubHost,
  GitLabHost,
  HostError,
  mapGithubComment,
  mapGithubFile,
  mapGithubPull,
  mapGitlabDiff,
  mapGitlabDiscussions,
  mapGitlabMr,
} from '../hosts';
import { parseRemoteUrl } from '../remote';

test('parses GitHub and GitLab remotes in https, ssh and scp form', () => {
  assert.deepEqual(parseRemoteUrl('https://github.com/michaeljude/reviewlens.git'), {
    kind: 'github',
    host: 'github.com',
    projectPath: 'michaeljude/reviewlens',
    webBase: 'https://github.com/michaeljude/reviewlens',
  });
  assert.equal(parseRemoteUrl('git@github.com:org/repo.git')?.projectPath, 'org/repo');
  assert.equal(parseRemoteUrl('ssh://git@ssh.github.com:443/org/repo.git')?.host, 'github.com');
  const gl = parseRemoteUrl('git@gitlab.com:group/sub/repo.git');
  assert.equal(gl?.kind, 'gitlab');
  assert.equal(gl?.projectPath, 'group/sub/repo');
  assert.equal(parseRemoteUrl('https://user@gitlab.acme.io/team/app')?.webBase, 'https://gitlab.acme.io/team/app');
  assert.equal(parseRemoteUrl('ssh://git@code.acme.io:2222/team/app.git', ['code.acme.io'])?.kind, 'gitlab');
  assert.equal(parseRemoteUrl('ssh://git@code.acme.io:2222/team/app.git'), undefined);
  assert.equal(parseRemoteUrl('https://bitbucket.org/team/app.git'), undefined);
  assert.equal(parseRemoteUrl('not a url'), undefined);
});

test('maps GitHub pull requests, files and comments', () => {
  const pr = mapGithubPull(
    {
      number: 7,
      title: 'Add cancel',
      body: 'Lets users cancel.',
      user: { login: 'Alice' },
      head: { ref: 'feat/cancel', sha: 'abc' },
      base: { ref: 'main' },
      html_url: 'https://github.com/o/r/pull/7',
      draft: false,
      updated_at: '2026-11-25T10:00:00Z',
      requested_reviewers: [{ login: 'bob' }],
    },
    'Bob',
  );
  assert.equal(pr.number, 7);
  assert.equal(pr.reviewRequested, true);
  assert.equal(pr.mine, false);
  assert.equal(pr.sourceBranch, 'feat/cancel');

  const f = mapGithubFile({ filename: 'a.ts', status: 'renamed', previous_filename: 'b.ts', additions: 2, deletions: 1, patch: '@@ -1 +1,2 @@\n-x\n+y\n+z' });
  assert.equal(f.status, 'R');
  assert.equal(f.oldPath, 'b.ts');
  assert.equal(f.binary, false);
  const big = mapGithubFile({ filename: 'big.json', status: 'modified', additions: 9000, deletions: 0 });
  assert.equal(big.tooLarge, true);
  const bin = mapGithubFile({ filename: 'logo.png', status: 'added', additions: 0, deletions: 0 });
  assert.equal(bin.binary, true);

  const c = mapGithubComment({ id: 2, in_reply_to_id: 1, path: 'a.ts', line: 4, body: 'Why?', user: { login: 'bob' }, created_at: 't', html_url: 'u' });
  assert.equal(c.threadId, '1');
  assert.equal(c.isReply, true);
  assert.equal(c.line, 4);
});

test('maps GitLab merge requests, diffs and discussions', () => {
  const mr = mapGitlabMr(
    { iid: 3, title: 'Fix', description: '', author: { username: 'me' }, source_branch: 's', target_branch: 't', web_url: 'w', draft: true, sha: 'x', reviewers: [] },
    'ME',
  );
  assert.equal(mr.number, 3);
  assert.equal(mr.mine, true);
  assert.equal(mr.draft, true);

  const d = mapGitlabDiff({ old_path: 'a.ts', new_path: 'a.ts', diff: '@@ -1 +1 @@\n-a\n+b\n+c\n', new_file: false, renamed_file: false, deleted_file: false });
  assert.deepEqual([d.status, d.added, d.deleted, d.binary], ['M', 2, 1, false]);
  const added = mapGitlabDiff({ old_path: 'n.ts', new_path: 'n.ts', diff: '@@ -0,0 +1 @@\n+x\n', new_file: true });
  assert.equal(added.status, 'A');
  const bin = mapGitlabDiff({ old_path: 'i.png', new_path: 'i.png', diff: 'Binary files a/i.png and b/i.png differ\n' });
  assert.equal(bin.binary, true);
  const large = mapGitlabDiff({ old_path: 'x', new_path: 'x', diff: '', too_large: true });
  assert.deepEqual([large.tooLarge, large.binary], [true, false]);

  const comments = mapGitlabDiscussions(
    [
      {
        id: 'd1',
        notes: [
          { id: 10, body: 'Rename this', author: { username: 'bob' }, created_at: 't', position: { new_path: 'a.ts', new_line: 5 }, resolvable: true, resolved: false },
          { id: 11, body: 'Done', author: { username: 'me' }, created_at: 't', position: { new_path: 'a.ts', new_line: 5 } },
        ],
      },
      { id: 'd2', notes: [{ id: 12, body: 'merged', system: true, author: { username: 'bot' } }] },
    ],
    'https://gitlab.com/g/p/-/merge_requests/3',
  );
  assert.equal(comments.length, 2);
  assert.equal(comments[0].resolved, false);
  assert.equal(comments[1].isReply, true);
  assert.equal(comments[0].url, 'https://gitlab.com/g/p/-/merge_requests/3#note_10');
});

test('counts diff lines, ignoring file headers', () => {
  assert.deepEqual(countDiffLines('--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n context'), { added: 1, deleted: 1 });
});

type Resp = { status?: number; body: unknown; link?: string };
function fakeFetch(routes: Record<string, Resp>, seen: string[]) {
  return async (url: string, init: { headers: Record<string, string> }) => {
    seen.push(url + ' ' + JSON.stringify(init.headers));
    const r = routes[url];
    const status = r ? (r.status ?? 200) : 404;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => (r ? r.body : {}),
      headers: { get: (n: string) => (n.toLowerCase() === 'link' ? (r?.link ?? null) : null) },
    };
  };
}

test('GitHub client follows pagination and sends the token', async () => {
  const remote = parseRemoteUrl('https://github.com/o/r')!;
  const seen: string[] = [];
  const api = 'https://api.github.com';
  const host = new GitHubHost(
    remote,
    'TOKEN',
    fakeFetch(
      {
        [`${api}/user`]: { body: { login: 'bob' } },
        [`${api}/repos/o/r/pulls?state=open&per_page=50&sort=updated&direction=desc`]: {
          body: [{ number: 1, title: 'A', user: { login: 'x' }, head: {}, base: {}, requested_reviewers: [{ login: 'bob' }] }],
        },
        [`${api}/repos/o/r/pulls/1/files?per_page=100`]: {
          body: [{ filename: 'a.ts', status: 'modified', additions: 1, deletions: 0, patch: '+a' }],
          link: `<${api}/repos/o/r/pulls/1/files?per_page=100&page=2>; rel="next"`,
        },
        [`${api}/repos/o/r/pulls/1/files?per_page=100&page=2`]: { body: [{ filename: 'b.ts', status: 'added', additions: 1, deletions: 0, patch: '+b' }] },
      },
      seen,
    ),
  );
  const prs = await host.listOpen();
  assert.equal(prs[0].reviewRequested, true);
  const files = await host.files(prs[0]);
  assert.deepEqual(files.map((f) => f.path), ['a.ts', 'b.ts']);
  assert.ok(seen.every((s) => s.includes('Bearer TOKEN')));
});

test('GitLab client falls back to /changes and reports auth errors clearly', async () => {
  const remote = parseRemoteUrl('https://gitlab.com/g/p')!;
  const base = 'https://gitlab.com/api/v4/projects/g%2Fp';
  const seen: string[] = [];
  const host = new GitLabHost(
    remote,
    'T',
    fakeFetch(
      {
        [`${base}/merge_requests/3/changes`]: { body: { changes: [{ old_path: 'a', new_path: 'a', diff: '+x\n' }] } },
      },
      seen,
    ),
  );
  const pr = mapGitlabMr({ iid: 3 }, '');
  const files = await host.files(pr);
  assert.deepEqual(files.map((f) => f.path), ['a']);
  assert.ok(seen[0].includes('PRIVATE-TOKEN'));

  const denied = new GitLabHost(remote, 'bad', fakeFetch({ 'https://gitlab.com/api/v4/user': { status: 401, body: {} } }, []));
  await assert.rejects(() => denied.listOpen(), (e: unknown) => e instanceof HostError && e.status === 401 && /Sign in again/.test(e.message));
});
