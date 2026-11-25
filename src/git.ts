import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';

/** Git's well-known empty tree, used as the base before the first commit. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const MAX_UNTRACKED_BYTES = 1_000_000;

export type ChangeStatus = 'M' | 'A' | 'D' | 'T' | 'U' | '?';

export interface ChangedFile {
  /** Path relative to the repo root, with forward slashes. */
  path: string;
  status: ChangeStatus;
  added: number;
  deleted: number;
  binary: boolean;
  untracked: boolean;
}

export interface ChangeSet {
  root: string;
  base: string;
  files: ChangedFile[];
}

interface RunResult {
  stdout: string;
  code: number;
}

function run(args: string[], cwd: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      if (err && typeof (err as NodeJS.ErrnoException).code !== 'number') {
        reject(err);
        return;
      }
      const code = err ? Number((err as NodeJS.ErrnoException).code) : 0;
      resolve({ stdout: stdout.toString(), code });
    });
  });
}

async function runOk(args: string[], cwd: string): Promise<string> {
  const r = await run(args, cwd);
  if (r.code !== 0) {
    throw new Error(`git ${args[0]} failed (exit ${r.code})`);
  }
  return r.stdout;
}

export async function repoRoot(dir: string): Promise<string | undefined> {
  try {
    const r = await run(['rev-parse', '--show-toplevel'], dir);
    return r.code === 0 ? r.stdout.trim() : undefined;
  } catch {
    return undefined;
  }
}

async function baseRef(root: string): Promise<string> {
  const r = await run(['rev-parse', '--verify', '--quiet', 'HEAD'], root);
  return r.code === 0 ? 'HEAD' : EMPTY_TREE;
}

/** Parses `git diff --name-status -z --no-renames` output. */
export function parseNameStatus(out: string): Array<{ status: ChangeStatus; path: string }> {
  const parts = out.split('\0').filter((p) => p.length > 0);
  const result: Array<{ status: ChangeStatus; path: string }> = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const letter = parts[i].charAt(0) as ChangeStatus;
    result.push({ status: letter, path: parts[i + 1] });
  }
  return result;
}

/** Parses `git diff --numstat -z --no-renames` output. Binary files show `-` counts. */
export function parseNumstat(out: string): Map<string, { added: number; deleted: number; binary: boolean }> {
  const map = new Map<string, { added: number; deleted: number; binary: boolean }>();
  for (const entry of out.split('\0')) {
    if (!entry) {
      continue;
    }
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(entry);
    if (!m) {
      continue;
    }
    const binary = m[1] === '-' || m[2] === '-';
    map.set(m[3], {
      added: binary ? 0 : Number(m[1]),
      deleted: binary ? 0 : Number(m[2]),
      binary,
    });
  }
  return map;
}

function looksBinary(buf: Buffer): boolean {
  const len = Math.min(buf.length, 8000);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) {
      return true;
    }
  }
  return false;
}

async function readUntracked(root: string, rel: string): Promise<{ text?: string; binary: boolean; lines: number }> {
  const abs = path.join(root, rel);
  try {
    const stat = await fs.stat(abs);
    if (!stat.isFile() || stat.size > MAX_UNTRACKED_BYTES) {
      return { binary: true, lines: 0 };
    }
    const buf = await fs.readFile(abs);
    if (looksBinary(buf)) {
      return { binary: true, lines: 0 };
    }
    const text = buf.toString('utf8');
    const lines = text.length === 0 ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    return { text, binary: false, lines };
  } catch {
    return { binary: true, lines: 0 };
  }
}

/** Lists every uncommitted change: staged, unstaged and untracked. */
export async function listChanges(root: string): Promise<ChangeSet> {
  const base = await baseRef(root);
  const [nameStatus, numstat, untracked] = await Promise.all([
    runOk(['diff', base, '--name-status', '-z', '--no-renames'], root),
    runOk(['diff', base, '--numstat', '-z', '--no-renames'], root),
    runOk(['ls-files', '--others', '--exclude-standard', '-z'], root),
  ]);
  const counts = parseNumstat(numstat);
  const files: ChangedFile[] = parseNameStatus(nameStatus).map((e) => {
    const c = counts.get(e.path) ?? { added: 0, deleted: 0, binary: false };
    return { path: e.path, status: e.status, added: c.added, deleted: c.deleted, binary: c.binary, untracked: false };
  });
  const untrackedPaths = untracked.split('\0').filter((p) => p.length > 0);
  const untrackedInfo = await Promise.all(untrackedPaths.map((p) => readUntracked(root, p)));
  untrackedPaths.forEach((p, i) => {
    const info = untrackedInfo[i];
    files.push({ path: p, status: '?', added: info.lines, deleted: 0, binary: info.binary, untracked: true });
  });
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { root, base, files };
}

/** Returns a unified diff for one file, with the given number of context lines. */
export async function fileDiff(set: ChangeSet, file: ChangedFile, contextLines: number): Promise<string> {
  if (file.binary) {
    return '';
  }
  if (file.untracked) {
    const info = await readUntracked(set.root, file.path);
    if (info.text === undefined) {
      return '';
    }
    const body = info.text.endsWith('\n') ? info.text.slice(0, -1) : info.text;
    const lines = body.length === 0 ? [] : body.split('\n');
    return [`new file ${file.path}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => '+' + l)].join('\n');
  }
  return runOk(['diff', set.base, `-U${contextLines}`, '--no-renames', '--no-color', '--', file.path], set.root);
}
