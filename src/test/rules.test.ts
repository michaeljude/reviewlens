import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test } from 'node:test';
import { buildPrompt, parseReview } from '../review';
import { globToRegExp, loadRules, parseFrontmatter, ruleFromDoc, rulesFingerprint, rulesFor, slugify } from '../reviewRules';

test('frontmatter: inline lists, dash lists, booleans and trailing comments', () => {
  const doc = parseFrontmatter(
    ['---', 'description: No logs', 'globs: ["src/**/*.ts", \'lib/*\']', 'severity: high   # high, medium or low', 'paths:', '  - a/**', '  - b/**', 'enabled: false', '# a comment', '---', '', 'Body text.'].join('\n'),
  );
  assert.equal(doc.meta.description, 'No logs');
  assert.deepEqual(doc.meta.globs, ['src/**/*.ts', 'lib/*']);
  assert.equal(doc.meta.severity, 'high');
  assert.deepEqual(doc.meta.paths, ['a/**', 'b/**']);
  assert.equal(doc.meta.enabled, false);
  assert.equal(doc.body, 'Body text.');
  assert.deepEqual(parseFrontmatter('Just a body').meta, {});
});

test('rule titles come from name, heading or file name', () => {
  assert.equal(ruleFromDoc('skill', '.reviewlens/skills/security-review/SKILL.md', '---\nname: Security\n---\nCheck auth.')!.title, 'Security');
  assert.equal(ruleFromDoc('rule', '.reviewlens/rules/x.md', '# No secrets\n\nNever commit keys.')!.title, 'No secrets');
  assert.equal(ruleFromDoc('skill', '.reviewlens/skills/security-review/SKILL.md', 'Check auth.')!.title, 'Security review');
  assert.equal(ruleFromDoc('rule', '.reviewlens/rules/x.md', '---\nseverity: low\n---\n'), undefined);
});

test('globs match like .gitignore', () => {
  const m = (g: string, p: string) => globToRegExp(g).test(p);
  assert.ok(m('*.ts', 'src/deep/a.ts'));
  assert.ok(!m('*.ts', 'src/a.tsx'));
  assert.ok(m('src/**/*.ts', 'src/a.ts'));
  assert.ok(m('src/**/*.ts', 'src/x/y/a.ts'));
  assert.ok(!m('src/*.ts', 'src/x/a.ts'));
  assert.ok(m('services/', 'services/api/a.go'));
  assert.ok(m('**/*.{ts,tsx}', 'apps/web/App.tsx'));
  assert.ok(m('./apps/mobile/**', 'apps/mobile/ios/x.swift'));
  assert.ok(!m('apps/mobile/**', 'apps/web/x.ts'));
  assert.ok(m('file?.md', 'docs/file1.md'));
});

test('loads rules, skills and personal rules; skips empty and disabled ones', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-rules-'));
  const w = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  w('.reviewlens/rules/no-logs.md', '---\ndescription: No personal data in logs\nglobs: services/**\nseverity: high\n---\nNo emails in logs.');
  w('.reviewlens/rules/off.md', '---\nenabled: false\n---\nOld rule.');
  w('.reviewlens/rules/empty.md', '');
  w('.reviewlens/rules/README.md', 'How to write rules.');
  w('.reviewlens/skills/security/SKILL.md', '---\nname: Security review\ndescription: For auth code\n---\n1. Check tokens.');
  w('.reviewlens/skills/a11y.md', 'Check labels.');
  const set = await loadRules(dir, ['Flag TODOs without a ticket.', '', 42]);
  const byTitle = new Map(set.rules.map((r) => [r.title, r]));
  assert.deepEqual(
    set.rules.map((r) => [r.id, r.kind, r.title]),
    [
      ['R1', 'rule', 'No personal data in logs'],
      ['R2', 'rule', 'Off'],
      ['S1', 'skill', 'A11y'],
      ['S2', 'skill', 'Security review'],
      ['R3', 'rule', 'Flag TODOs without a ticket.'],
    ],
  );
  assert.equal(byTitle.get('Off')!.enabled, false);
  assert.equal(byTitle.get('No personal data in logs')!.severity, 'high');
  assert.equal(byTitle.get('Flag TODOs without a ticket.')!.source, 'settings');
  assert.match(set.problems[0], /empty\.md is empty/);

  const forApi = rulesFor(set, 'services/api/user.ts').map((r) => r.id);
  assert.deepEqual(forApi, ['R1', 'S1', 'S2', 'R3']);
  assert.deepEqual(rulesFor(set, 'apps/web/App.tsx').map((r) => r.id), ['S1', 'S2', 'R3']);
  assert.deepEqual(await loadRules(undefined, undefined), { rules: [], problems: [] });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rules fingerprint is empty without rules and changes with the rule text', () => {
  const base = ruleFromDoc('rule', 'r.md', 'No logs.')!;
  const a = { ...base, id: 'R1' };
  assert.equal(rulesFingerprint([]), '');
  assert.equal(rulesFingerprint([a]), rulesFingerprint([{ ...a, id: 'R9' }]));
  assert.notEqual(rulesFingerprint([a]), rulesFingerprint([{ ...a, body: 'No logs at all.' }]));
  assert.equal(slugify('No personal data in logs!'), 'no-personal-data-in-logs');
});

test('prompt sends only the rules that apply to the files under review', () => {
  const r1 = { ...ruleFromDoc('rule', '.reviewlens/rules/a.md', '---\nglobs: services/**\nseverity: high\n---\nNo emails in logs.')!, id: 'R1' };
  const r2 = { ...ruleFromDoc('rule', '.reviewlens/rules/b.md', '---\nglobs: apps/mobile/**\n---\nUse the design system.')!, id: 'R2' };
  const s1 = { ...ruleFromDoc('skill', '.reviewlens/skills/sec/SKILL.md', '---\nname: Security\ndescription: auth code\n---\nCheck tokens.')!, id: 'S1' };
  const prompt = buildPrompt([{ path: 'services/a.ts', area: 'Backend', status: 'M', diff: '+x', shortened: false, ruleIds: ['R1', 'S1'] }], [], undefined, [r1, r2, s1]);
  assert.match(prompt, /\[R1\] Rule: A \(severity: high; applies to: services\/\*\*\)/);
  assert.match(prompt, /\[S1\] Skill: Security \(applies to: all files\)\nWhen to use: auth code/);
  assert.doesNotMatch(prompt, /design system/);
  assert.match(prompt, /### services\/a\.ts \(area: Backend, status: modified, check against: R1, S1\)/);
  assert.match(prompt, /"findings"/);
  const plain = buildPrompt([{ path: 'x.ts', area: 'Other', status: 'M', diff: '+x', shortened: false }], [], undefined, [r1]);
  assert.doesNotMatch(plain, /findings|BEGIN RULE/);
});

test('parses findings, maps rule ids to titles and raises the file risk', () => {
  const r = parseReview(
    JSON.stringify({
      files: [
        {
          path: 'services/a.ts',
          risk: 'low',
          findings: [
            { rule: 'R1', level: 'high', text: 'Logs the user email.', line: '12' },
            { rule: '[s1]', level: 'weird', text: 'Token not checked.', line: -3 },
            { rule: 'R9', text: '' },
          ],
        },
        { path: 'b.ts', risk: 'low', findings: [] },
        { path: 'c.ts', risk: 'low' },
      ],
    }),
    new Map([
      ['R1', 'No personal data in logs'],
      ['S1', 'Security'],
    ]),
  );
  const a = r.files.get('services/a.ts')!;
  assert.equal(a.risk, 'high');
  assert.deepEqual(a.findings, [
    { rule: 'No personal data in logs', level: 'high', text: 'Logs the user email.', line: 12 },
    { rule: 'Security', level: 'medium', text: 'Token not checked.' },
  ]);
  assert.deepEqual(r.files.get('b.ts')!.findings, []);
  assert.equal(r.files.get('b.ts')!.risk, 'low');
  assert.equal(r.files.get('c.ts')!.findings, undefined);
});
