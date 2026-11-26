import { strict as assert } from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test } from 'node:test';
import { areaFor, ruleCategory, skipForAi } from '../classify';
import { BackendError, cliErrorMessage, isWorkspaceTrustPrompt, unwrapCliOutput, workspaceTrustMessage } from '../cli';
import { fileDiff, listChanges, parseNameStatus, parseNumstat } from '../git';
import { buildPrompt, extractJsonObject, hashDiff, parseReview, shorten } from '../review';

const AREAS = {
  Mobile: ['apps/mobile/'],
  Backend: ['services/'],
  Shared: ['packages/'],
};

test('areas match by path prefix', () => {
  assert.equal(areaFor('apps/mobile/src/screens/OrderDetail.tsx', AREAS), 'Mobile');
  assert.equal(areaFor('services/api/src/payments/refund.service.ts', AREAS), 'Backend');
  assert.equal(areaFor('packages/shared/types/order.ts', AREAS), 'Shared');
  assert.equal(areaFor('README.md', AREAS), 'Other');
});

test('path rules categorise obvious files and leave the rest to the AI', () => {
  assert.equal(ruleCategory('services/api/src/payments/refund.service.test.ts'), 'test');
  assert.equal(ruleCategory('apps/mobile/__tests__/OrderDetail.tsx'), 'test');
  assert.equal(ruleCategory('.github/workflows/api-ci.yml'), 'ci');
  assert.equal(ruleCategory('.gitlab-ci.yml'), 'ci');
  assert.equal(ruleCategory('services/api/migrations/20261125_add_cancelled_at.sql'), 'database');
  assert.equal(ruleCategory('infra/terraform/main.tf'), 'infra');
  assert.equal(ruleCategory('Dockerfile'), 'infra');
  assert.equal(ruleCategory('scripts/release.sh'), 'automation');
  assert.equal(ruleCategory('package.json'), 'config');
  assert.equal(ruleCategory('docs/setup.md'), 'docs');
  assert.equal(ruleCategory('apps/mobile/src/screens/OrderDetail.tsx'), undefined);
  assert.equal(ruleCategory('services/api/src/payments/refund.service.ts'), undefined);
});

test('lockfiles and build output are not sent to the AI', () => {
  assert.equal(skipForAi('package-lock.json'), true);
  assert.equal(skipForAi('apps/mobile/ios/Podfile.lock'), true);
  assert.equal(skipForAi('apps/web/dist/main.js'), true);
  assert.equal(skipForAi('services/api/src/index.ts'), false);
});

test('parses git name-status and numstat output', () => {
  assert.deepEqual(parseNameStatus('M\0src/a.ts\0A\0src/b ts.ts\0D\0old.ts\0'), [
    { status: 'M', path: 'src/a.ts' },
    { status: 'A', path: 'src/b ts.ts' },
    { status: 'D', path: 'old.ts' },
  ]);
  const n = parseNumstat('3\t1\tsrc/a.ts\0-\t-\timg.png\0');
  assert.deepEqual(n.get('src/a.ts'), { added: 3, deleted: 1, binary: false });
  assert.deepEqual(n.get('img.png'), { added: 0, deleted: 0, binary: true });
});

test('extracts JSON from replies wrapped in fences or prose', () => {
  assert.deepEqual(extractJsonObject('Sure!\n```json\n{"a": {"b": "x } y"}}\n```'), { a: { b: 'x } y' } });
  assert.throws(() => extractJsonObject('no json here'));
});

test('parses and cleans an AI review', () => {
  const r = parseReview(
    JSON.stringify({
      summary: 'Adds order cancellation.',
      files: [
        {
          path: 'packages/shared/types/order.ts',
          category: 'types',
          why: 'Adds a cancelled status.',
          what: ['Adds cancelled to OrderStatus', ''],
          impacts: [{ kind: 'Contract', level: 'HIGH', text: 'Switches need a new case.' }, { kind: 'x', level: 'low', text: '' }],
          risk: 'high',
        },
        { path: 'weird.ts', category: 'nonsense', risk: 'extreme' },
        { why: 'no path' },
      ],
    }),
  );
  assert.equal(r.summary, 'Adds order cancellation.');
  assert.equal(r.files.size, 2);
  const a = r.files.get('packages/shared/types/order.ts')!;
  assert.equal(a.category, 'types');
  assert.deepEqual(a.what, ['Adds cancelled to OrderStatus']);
  assert.deepEqual(a.impacts, [{ kind: 'Contract', level: 'high', text: 'Switches need a new case.' }]);
  const w = r.files.get('weird.ts')!;
  assert.equal(w.category, undefined);
  assert.equal(w.risk, 'medium');
});

test('prompt lists every file and marks shortened diffs', () => {
  const s = shorten('x'.repeat(50), 10);
  assert.equal(s.shortened, true);
  const prompt = buildPrompt(
    [{ path: 'a.ts', area: 'Backend', status: 'M', diff: s.diff, shortened: s.shortened, categoryHint: 'logic' }],
    ['package-lock.json'],
  );
  assert.match(prompt, /### a\.ts \(area: Backend, status: modified, category from path rules: logic, diff shortened\)/);
  assert.match(prompt, /- package-lock\.json/);
});

test('CLI output: unwraps replies and turns error envelopes into short messages', () => {
  assert.equal(unwrapCliOutput('{"type":"result","is_error":false,"result":"{\\"files\\":[]}"}'), '{"files":[]}');
  assert.equal(unwrapCliOutput('plain text'), 'plain text');
  const expired = '{"type":"result","is_error":true,"terminal_reason":"api_error","result":"Failed to authenticate: OAuth session expired and could not be refreshed"}';
  assert.throws(() => unwrapCliOutput(expired), BackendError);
  const msg = cliErrorMessage('Claude Code CLI', expired, '', 1);
  assert.match(msg, /^Claude Code CLI: Failed to authenticate: OAuth session expired/);
  assert.match(msg, /Sign in again/);
  assert.equal(cliErrorMessage('Cursor agent CLI', '', 'boom\n', 2), 'Cursor agent CLI: boom');
});

test('CLI output: spots the Cursor agent workspace trust prompt', () => {
  const prompt =
    '\n⚠ Workspace Trust Required\n\n  Cursor Agent can execute code and access files in this directory.\n  Do you trust the contents of this directory?\n\n    /repo\n\n  To proceed, you can either:\n    • Run \'agent\' interactively to decide\n    • Pass --trust, --yolo, or -f if you trust this directory\n';
  assert.equal(isWorkspaceTrustPrompt('', prompt), true);
  assert.equal(isWorkspaceTrustPrompt('', 'boom'), false);
  assert.match(workspaceTrustMessage('Cursor agent CLI'), /^Cursor agent CLI: it hasn't been allowed to work in this folder yet\./);
});

test('hash changes when the diff changes', () => {
  assert.notEqual(hashDiff('a.ts', '+one'), hashDiff('a.ts', '+two'));
  assert.equal(hashDiff('a.ts', '+one'), hashDiff('a.ts', '+one'));
});

test('lists staged, unstaged and untracked changes in a real repo', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acr-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  fs.writeFileSync(path.join(dir, 'kept.ts'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(dir, 'gone.ts'), 'export const b = 2;\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  fs.writeFileSync(path.join(dir, 'kept.ts'), 'export const a = 2;\nexport const c = 3;\n');
  fs.unlinkSync(path.join(dir, 'gone.ts'));
  fs.mkdirSync(path.join(dir, 'services'));
  fs.writeFileSync(path.join(dir, 'services', 'new.ts'), 'line1\nline2\n');
  fs.writeFileSync(path.join(dir, 'staged.ts'), 'staged\n');
  git('add', 'staged.ts');

  const set = await listChanges(dir);
  const byPath = new Map(set.files.map((f) => [f.path, f]));
  assert.deepEqual([...byPath.keys()].sort(), ['gone.ts', 'kept.ts', 'services/new.ts', 'staged.ts']);
  assert.equal(byPath.get('kept.ts')!.status, 'M');
  assert.equal(byPath.get('kept.ts')!.added, 2);
  assert.equal(byPath.get('gone.ts')!.status, 'D');
  assert.equal(byPath.get('staged.ts')!.status, 'A');
  assert.equal(byPath.get('services/new.ts')!.status, '?');
  assert.equal(byPath.get('services/new.ts')!.added, 2);

  const diff = await fileDiff(set, byPath.get('kept.ts')!, 3);
  assert.match(diff, /\+export const c = 3;/);
  const untrackedDiff = await fileDiff(set, byPath.get('services/new.ts')!, 3);
  assert.match(untrackedDiff, /^\+line2$/m);
  fs.rmSync(dir, { recursive: true, force: true });
});
