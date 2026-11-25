import { createHash } from 'crypto';
import { CATEGORY_IDS, CategoryId } from './classify';

export type Level = 'high' | 'medium' | 'low';

export interface Impact {
  kind: string;
  level: Level;
  text: string;
}

export interface FileAnalysis {
  category?: CategoryId;
  why: string;
  what: string[];
  impacts: Impact[];
  risk: Level;
}

export interface ReviewResult {
  summary?: string;
  files: Map<string, FileAnalysis>;
}

export interface PacketFile {
  path: string;
  area: string;
  status: string;
  categoryHint?: string;
  diff: string;
  shortened: boolean;
}

export function hashDiff(filePath: string, diff: string): string {
  return createHash('sha1').update(filePath).update('\0').update(diff).digest('hex');
}

/** Rough token estimate: about four characters per token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function shorten(diff: string, maxChars: number): { diff: string; shortened: boolean } {
  if (diff.length <= maxChars) {
    return { diff, shortened: false };
  }
  return { diff: diff.slice(0, maxChars) + '\n… (diff shortened)', shortened: true };
}

const STATUS_WORDS: Record<string, string> = {
  M: 'modified',
  A: 'added',
  D: 'deleted',
  T: 'type changed',
  U: 'unmerged',
  '?': 'new (untracked)',
};

export function statusWord(status: string): string {
  return STATUS_WORDS[status] ?? status;
}

export function buildPrompt(files: PacketFile[], otherChangedPaths: string[]): string {
  const lines: string[] = [];
  lines.push(
    'You are helping a developer review uncommitted code changes, often written by an AI agent, so they can understand and approve them quickly.',
    'Do not edit files, run commands or use tools. Reply with only one JSON object and nothing else, in this shape:',
    '{',
    '  "summary": "2-3 sentences on what this set of changes does overall",',
    '  "files": [',
    '    {',
    '      "path": "the exact path as given below",',
    '      "category": "one of: ui, logic, api, types, database, test, infra, ci, automation, config, docs, other",',
    '      "why": "1-2 sentences on the likely intent behind this change",',
    '      "what": ["1 to 4 short bullets on what changed"],',
    '      "impacts": [{ "kind": "a short label such as Behaviour, Contract, Data, Security, UX, Performance or Deploy", "level": "high | medium | low", "text": "what could break or change, and where" }],',
    '      "risk": "high | medium | low"',
    '    }',
    '  ]',
    '}',
    '',
    'Rules:',
    '- Include every file listed under "Files to review" exactly once.',
    '- Base every claim on the diffs. When you are unsure, say so instead of guessing.',
    '- Use 0 to 4 impacts per file. Call out effects on other files in this change set, for example a shared type or endpoint used by another area.',
    '- If a diff is marked as shortened, say the analysis is partial.',
    '',
  );
  if (otherChangedPaths.length > 0) {
    lines.push('Other files changed in the same set (not sent, for context only):');
    for (const p of otherChangedPaths) {
      lines.push(`- ${p}`);
    }
    lines.push('');
  }
  lines.push('Files to review:', '');
  for (const f of files) {
    const hint = f.categoryHint ? `, category from path rules: ${f.categoryHint}` : '';
    lines.push(`### ${f.path} (area: ${f.area}, status: ${statusWord(f.status)}${hint}${f.shortened ? ', diff shortened' : ''})`);
    lines.push('--- BEGIN DIFF ---');
    lines.push(f.diff);
    lines.push('--- END DIFF ---');
    lines.push('');
  }
  return lines.join('\n');
}

function asLevel(v: unknown, fallback: Level): Level {
  const s = typeof v === 'string' ? v.toLowerCase().trim() : '';
  return s === 'high' || s === 'medium' || s === 'low' ? s : fallback;
}

function asText(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** Pulls the first top-level JSON object out of a model reply (tolerates code fences and prose). */
export function extractJsonObject(text: string): unknown {
  const start = text.indexOf('{');
  if (start < 0) {
    throw new Error('The AI reply did not contain JSON.');
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return JSON.parse(text.slice(start, i + 1));
      }
    }
  }
  throw new Error('The AI reply contained incomplete JSON.');
}

export function parseReview(text: string): ReviewResult {
  const raw = extractJsonObject(text) as { summary?: unknown; files?: unknown };
  const files = new Map<string, FileAnalysis>();
  const list = Array.isArray(raw.files) ? raw.files : [];
  for (const item of list) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const f = item as Record<string, unknown>;
    const p = asText(f.path);
    if (!p) {
      continue;
    }
    const category = asText(f.category).toLowerCase();
    const what = Array.isArray(f.what) ? f.what.map(asText).filter((s) => s.length > 0).slice(0, 6) : [];
    const impacts: Impact[] = Array.isArray(f.impacts)
      ? f.impacts
          .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
          .map((x) => ({ kind: asText(x.kind) || 'Impact', level: asLevel(x.level, 'low'), text: asText(x.text) }))
          .filter((x) => x.text.length > 0)
          .slice(0, 6)
      : [];
    files.set(p, {
      category: CATEGORY_IDS.has(category) ? (category as CategoryId) : undefined,
      why: asText(f.why),
      what,
      impacts,
      risk: asLevel(f.risk, 'medium'),
    });
  }
  const summary = asText(raw.summary);
  return { summary: summary || undefined, files };
}
