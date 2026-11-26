/*
 * Diff rows with line numbers, and comment threads anchored to them. No VS Code imports.
 */
import { PrComment, Side } from './hosts';

export type RowKind = 'meta' | 'hunk' | 'add' | 'del' | 'ctx';

export interface DiffRow {
  k: RowKind;
  t: string;
  /** Line number in the old file (removed and context lines). */
  o?: number;
  /** Line number in the new file (added and context lines). */
  n?: number;
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Splits a unified diff into rows, numbering each line on the old and new side. */
export function parsePatch(patch: string): DiffRow[] {
  const rows: DiffRow[] = [];
  if (!patch) {
    return rows;
  }
  const lines = patch.split('\n');
  if (lines[lines.length - 1] === '') {
    lines.pop();
  }
  let inHunk = false;
  let oldNo = 0;
  let newNo = 0;
  for (const t of lines) {
    const m = HUNK.exec(t);
    if (m) {
      oldNo = Number(m[1]);
      newNo = Number(m[2]);
      inHunk = true;
      rows.push({ k: 'hunk', t });
      continue;
    }
    if (t.startsWith('diff --git ')) {
      inHunk = false;
    }
    if (!inHunk || t.startsWith('\\')) {
      rows.push({ k: 'meta', t });
    } else if (t.startsWith('+')) {
      rows.push({ k: 'add', t, n: newNo++ });
    } else if (t.startsWith('-')) {
      rows.push({ k: 'del', t, o: oldNo++ });
    } else {
      rows.push({ k: 'ctx', t, o: oldNo++, n: newNo++ });
    }
  }
  return rows;
}

/** The row a line comment belongs on, or -1 when the line isn't in the diff. */
export function rowFor(rows: DiffRow[], line: number | undefined, side: Side | undefined): number {
  if (!line) {
    return -1;
  }
  return rows.findIndex((r) => (side === 'old' ? r.o === line && r.k !== 'add' : r.n === line && r.k !== 'del'));
}

export interface ThreadView {
  id: string;
  line?: number;
  side?: Side;
  outdated: boolean;
  resolved: boolean;
  resolvable: boolean;
  /** Index of the diff row it is shown under; -1 shows it with the file's other comments. */
  row: number;
  comments: Array<{ id: string; author: string; body: string; createdAt: string; url?: string }>;
}

/** Groups a file's comments into threads, oldest first, and anchors each to a diff row. */
export function groupThreads(comments: PrComment[], rows: DiffRow[]): ThreadView[] {
  const byId = new Map<string, PrComment[]>();
  for (const c of comments) {
    const list = byId.get(c.threadId) ?? [];
    list.push(c);
    byId.set(c.threadId, list);
  }
  const threads: ThreadView[] = [];
  for (const [id, list] of byId) {
    list.sort((a, b) => Number(a.isReply) - Number(b.isReply) || a.createdAt.localeCompare(b.createdAt));
    const root = list[0];
    threads.push({
      id,
      line: root.line,
      side: root.side,
      outdated: root.outdated === true,
      resolved: root.resolved === true,
      resolvable: root.resolvable,
      row: root.outdated ? -1 : rowFor(rows, root.line, root.side),
      comments: list.map((c) => ({ id: c.id, author: c.author, body: c.body, createdAt: c.createdAt, url: c.url })),
    });
  }
  return threads.sort((a, b) => (a.row === -1 ? 1e9 : a.row) - (b.row === -1 ? 1e9 : b.row) || (a.comments[0]?.createdAt ?? '').localeCompare(b.comments[0]?.createdAt ?? ''));
}
