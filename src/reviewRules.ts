import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';

/*
 * Developer review rules and skills: instructions the AI follows when it reviews changes.
 *
 * - Rules: `.reviewlens/rules/*.md`, one rule per file. Short checks the AI tests every matching file against;
 *   each broken rule comes back as a finding on the file.
 * - Skills: `.reviewlens/skills/<name>/SKILL.md` (or `.reviewlens/skills/<name>.md`). Longer review playbooks,
 *   such as a security checklist, in the same format as Claude Code and Cursor skills.
 * - Personal rules: the `reviewLens.rules` setting, a list of one-line rules.
 *
 * All of them are read from your local working tree, never from a pull/merge request, so a PR can't change
 * the rules it is reviewed against.
 */

export type RuleKind = 'rule' | 'skill';
export type RuleLevel = 'high' | 'medium' | 'low';

export interface ReviewRule {
  /** Short id used in the prompt, such as R1 or S2. */
  id: string;
  kind: RuleKind;
  title: string;
  description?: string;
  /** Glob patterns; empty means every file. */
  globs: string[];
  severity: RuleLevel;
  body: string;
  /** Repo-relative file it came from, or "settings". */
  source: string;
  enabled: boolean;
  /** The body was cut to fit the limit. */
  shortened: boolean;
}

export interface RuleSet {
  rules: ReviewRule[];
  /** Problems reading rule files, shown to the developer. */
  problems: string[];
}

export const RULES_DIR = '.reviewlens/rules';
export const SKILLS_DIR = '.reviewlens/skills';
export const MAX_RULE_CHARS = 4000;
export const MAX_SKILL_CHARS = 12000;
export const MAX_RULE_FILES = 100;

// ---------- Frontmatter ----------

export interface ParsedDoc {
  meta: Record<string, string | string[] | boolean>;
  body: string;
}

function unquote(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

function scalar(raw: string): string | string[] | boolean {
  // Drop a trailing "# comment" unless the value is quoted.
  const t = /^["']/.test(raw.trim()) ? raw.trim() : raw.replace(/\s+#.*$/, '').trim();
  if (t === 'true' || t === 'false') {
    return t === 'true';
  }
  if (t.startsWith('[') && t.endsWith(']')) {
    return t
      .slice(1, -1)
      .split(',')
      .map(unquote)
      .filter((s) => s.length > 0);
  }
  return unquote(t);
}

/** Reads simple YAML frontmatter (key: value, inline lists and "- item" lists). Unknown shapes are ignored. */
export function parseFrontmatter(text: string): ParsedDoc {
  const src = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(src);
  if (!m) {
    return { meta: {}, body: src.trim() };
  }
  const meta: ParsedDoc['meta'] = {};
  let listKey: string | undefined;
  for (const line of m[1].split('\n')) {
    const item = /^\s+-\s+(.*)$/.exec(line) ?? /^-\s+(.*)$/.exec(line);
    if (item && listKey) {
      const cur = meta[listKey];
      meta[listKey] = [...(Array.isArray(cur) ? cur : []), unquote(item[1])];
      continue;
    }
    const kv = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) {
      continue;
    }
    const key = kv[1];
    if (kv[2].trim() === '') {
      meta[key] = [];
      listKey = key;
    } else {
      meta[key] = scalar(kv[2]);
      listKey = undefined;
    }
  }
  return { meta, body: src.slice(m[0].length).trim() };
}

function metaText(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function metaList(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v.map((s) => String(s).trim()).filter((s) => s.length > 0);
  }
  if (typeof v === 'string') {
    return v
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return [];
}

function metaLevel(v: unknown): RuleLevel {
  const s = typeof v === 'string' ? v.toLowerCase().trim() : '';
  return s === 'high' || s === 'low' ? s : 'medium';
}

/** First Markdown heading, if the body starts with one. */
function headingTitle(body: string): string | undefined {
  const m = /^#{1,3}\s+(.+)$/.exec(body.trimStart().split('\n')[0]);
  return m ? m[1].trim() : undefined;
}

function titleFromFile(file: string): string {
  const base = path.basename(file).replace(/\.(md|mdc|txt)$/i, '');
  const name = base.toUpperCase() === 'SKILL' ? path.basename(path.dirname(file)) : base;
  const words = name.replace(/[-_]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Untitled';
}

/** A rule's short description doubles as its title (as in Cursor rules); a skill's says when to use it. */
function ruleDescriptionTitle(kind: RuleKind, v: unknown): string | undefined {
  const d = metaText(v);
  return kind === 'rule' && d && d.length <= 80 ? d : undefined;
}

function clip(body: string, max: number): { body: string; shortened: boolean } {
  return body.length <= max ? { body, shortened: false } : { body: body.slice(0, max) + '\n… (shortened)', shortened: true };
}

/** Turns one rule or skill file into a rule. `source` is the repo-relative path. */
export function ruleFromDoc(kind: RuleKind, source: string, text: string): Omit<ReviewRule, 'id'> | undefined {
  const { meta, body } = parseFrontmatter(text);
  if (!body) {
    return undefined;
  }
  const c = clip(body, kind === 'rule' ? MAX_RULE_CHARS : MAX_SKILL_CHARS);
  const enabled = meta.enabled !== false && meta.disabled !== true;
  return {
    kind,
    title: metaText(meta.name) ?? metaText(meta.title) ?? headingTitle(body) ?? ruleDescriptionTitle(kind, meta.description) ?? titleFromFile(source),
    description: metaText(meta.description),
    globs: metaList(meta.globs ?? meta.paths ?? meta.files),
    severity: metaLevel(meta.severity),
    body: c.body,
    source,
    enabled,
    shortened: c.shortened,
  };
}

// ---------- Globs ----------

/** Converts a glob (`*`, `**`, `?`, `{a,b}`) to a regular expression for repo-relative paths. */
export function globToRegExp(glob: string): RegExp {
  let g = glob.trim().replace(/\\/g, '/');
  if (g.startsWith('./')) {
    g = g.slice(2);
  }
  if (g.startsWith('/')) {
    g = g.slice(1);
  }
  // A pattern without a slash matches the file name in any folder, as in .gitignore.
  if (!g.includes('/')) {
    g = '**/' + g;
  }
  // A folder pattern matches everything under it.
  if (g.endsWith('/')) {
    g += '**';
  }
  let re = '';
  let inBraces = false;
  for (let i = 0; i < g.length; i++) {
    const ch = g[i];
    if (ch === '*') {
      if (g[i + 1] === '*') {
        const slashAfter = g[i + 2] === '/';
        re += slashAfter ? '(?:.*/)?' : '.*';
        i += slashAfter ? 2 : 1;
      } else {
        re += '[^/]*';
      }
    } else if (ch === '?') {
      re += '[^/]';
    } else if (ch === '{') {
      inBraces = true;
      re += '(?:';
    } else if (ch === '}' && inBraces) {
      inBraces = false;
      re += ')';
    } else if (ch === ',' && inBraces) {
      re += '|';
    } else {
      re += ch.replace(/[.+^$()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp('^' + re + '$');
}

export function ruleApplies(rule: Pick<ReviewRule, 'globs'>, filePath: string): boolean {
  return rule.globs.length === 0 || rule.globs.some((g) => globToRegExp(g).test(filePath));
}

// ---------- Loading ----------

async function readDirSafe(dir: string): Promise<Array<{ name: string; isDir: boolean }>> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.map((e) => ({ name: e.name, isDir: e.isDirectory() })).sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

async function ruleFiles(root: string): Promise<Array<{ kind: RuleKind; rel: string }>> {
  const out: Array<{ kind: RuleKind; rel: string }> = [];
  for (const e of await readDirSafe(path.join(root, RULES_DIR))) {
    if (!e.isDir && /\.(md|mdc)$/i.test(e.name) && !/^readme\.md$/i.test(e.name)) {
      out.push({ kind: 'rule', rel: `${RULES_DIR}/${e.name}` });
    }
  }
  for (const e of await readDirSafe(path.join(root, SKILLS_DIR))) {
    if (e.isDir) {
      const inner = await readDirSafe(path.join(root, SKILLS_DIR, e.name));
      const skill = inner.find((f) => !f.isDir && f.name.toLowerCase() === 'skill.md');
      if (skill) {
        out.push({ kind: 'skill', rel: `${SKILLS_DIR}/${e.name}/${skill.name}` });
      }
    } else if (/\.md$/i.test(e.name) && !/^readme\.md$/i.test(e.name)) {
      out.push({ kind: 'skill', rel: `${SKILLS_DIR}/${e.name}` });
    }
  }
  return out.slice(0, MAX_RULE_FILES);
}

/** Reads the repo's rule and skill files and the personal rules from settings. Never throws. */
export async function loadRules(root: string | undefined, personal: unknown): Promise<RuleSet> {
  const found: Array<Omit<ReviewRule, 'id'>> = [];
  const problems: string[] = [];
  if (root) {
    for (const f of await ruleFiles(root)) {
      try {
        const text = await fs.readFile(path.join(root, f.rel), 'utf8');
        const r = ruleFromDoc(f.kind, f.rel, text);
        if (r) {
          found.push(r);
        } else {
          problems.push(`${f.rel} is empty, so it was skipped.`);
        }
      } catch (e) {
        problems.push(`Couldn't read ${f.rel}: ${(e as Error).message}`);
      }
    }
  }
  if (Array.isArray(personal)) {
    for (const p of personal) {
      const text = typeof p === 'string' ? p.trim() : '';
      if (!text) {
        continue;
      }
      const c = clip(text, MAX_RULE_CHARS);
      found.push({
        kind: 'rule',
        title: text.split('\n')[0].slice(0, 80),
        globs: [],
        severity: 'medium',
        body: c.body,
        source: 'settings',
        enabled: true,
        shortened: c.shortened,
      });
    }
  }
  let r = 0;
  let s = 0;
  const rules = found.map((x) => ({ ...x, id: x.kind === 'rule' ? `R${++r}` : `S${++s}` }));
  return { rules, problems };
}

// ---------- Applying ----------

/** The enabled rules and skills that apply to a file. */
export function rulesFor(set: RuleSet | undefined, filePath: string): ReviewRule[] {
  return (set?.rules ?? []).filter((r) => r.enabled && ruleApplies(r, filePath));
}

/**
 * A fingerprint of the rules that apply to a file. Saved AI results are keyed by it as well as by the diff,
 * so changing a rule asks for a new review of exactly the files it covers. Empty when no rules apply.
 */
export function rulesFingerprint(rules: ReviewRule[]): string {
  if (rules.length === 0) {
    return '';
  }
  const h = createHash('sha1');
  for (const r of rules) {
    h.update(r.kind).update('\0').update(r.title).update('\0').update(r.severity).update('\0').update(r.body).update('\0\0');
  }
  return h.digest('hex');
}

/** Short, readable label for the list of rules and skills. */
export function describeRules(set: RuleSet | undefined): string {
  const enabled = (set?.rules ?? []).filter((r) => r.enabled);
  const rules = enabled.filter((r) => r.kind === 'rule').length;
  const skills = enabled.length - rules;
  const parts: string[] = [];
  if (rules) {
    parts.push(`${rules} rule${rules === 1 ? '' : 's'}`);
  }
  if (skills) {
    parts.push(`${skills} skill${skills === 1 ? '' : 's'}`);
  }
  return parts.join(', ');
}

/** File name for a new rule or skill, from its title. */
export function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/[\s_]+/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 60) || 'rule'
  );
}

export function ruleTemplate(kind: RuleKind, title: string): string {
  if (kind === 'skill') {
    return [
      '---',
      `name: ${title}`,
      'description: When and how to apply this review playbook.',
      '# globs: ["services/**", "apps/api/**"]   # optional: only for these files',
      '---',
      '',
      `# ${title}`,
      '',
      'Describe how the AI should review changes, for example a checklist:',
      '',
      '1. …',
      '2. …',
      '',
      'Anything a change gets wrong is reported as a finding on the file.',
      '',
    ].join('\n');
  }
  return [
    '---',
    `description: ${title}`,
    '# globs: ["src/**/*.ts"]   # optional: only for these files',
    'severity: medium           # high, medium or low',
    '---',
    '',
    `# ${title}`,
    '',
    'Say what every change must (or must not) do, in a few sentences. Example:',
    '',
    '- Don’t log personal data (emails, phone numbers, tokens).',
    '',
  ].join('\n');
}
