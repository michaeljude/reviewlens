/*
 * What's new on a pull/merge request since the developer last looked, and how to say it.
 * No VS Code imports, so it can be unit tested.
 */
import { PrComment, PrReview } from './hosts';

export type ActivityKind = 'comment' | 'approved' | 'changes' | 'reviewed';

export interface ActivityItem {
  id: string;
  kind: ActivityKind;
  author: string;
  body: string;
}

/** Everyone else's comments and reviews, each with a stable id. Your own are left out. */
export function activityItems(comments: PrComment[], reviews: PrReview[], me: string): ActivityItem[] {
  const self = me.toLowerCase();
  const out: ActivityItem[] = [];
  for (const c of comments) {
    if (c.author.toLowerCase() !== self) {
      out.push({ id: `c:${c.id}`, kind: 'comment', author: c.author, body: c.body });
    }
  }
  for (const r of reviews) {
    if (r.author.toLowerCase() === self || r.state === 'pending' || r.state === 'dismissed') {
      continue;
    }
    // A comment-only review with no text is just the wrapper GitHub makes around line comments.
    if (r.state === 'commented' && !r.body.trim()) {
      continue;
    }
    out.push({ id: `r:${r.id}`, kind: r.state === 'approved' ? 'approved' : r.state === 'changes' ? 'changes' : 'reviewed', author: r.author, body: r.body });
  }
  return out;
}

export function unseen(items: ActivityItem[], seen: Iterable<string>): ActivityItem[] {
  const s = new Set(seen);
  return items.filter((i) => !s.has(i.id));
}

function names(list: string[]): string {
  const u = [...new Set(list)].map((n) => `@${n}`);
  if (u.length <= 2) {
    return u.join(' and ');
  }
  return `${u.slice(0, 2).join(', ')} and ${u.length - 2} more`;
}

function clip(s: string, max: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? one.slice(0, max - 1) + '…' : one;
}

/** One sentence for a notification, for example: "@ana approved #12 “Add cancel”. @bo left 2 comments." */
export function describeActivity(items: ActivityItem[], pr: { number: number; title: string }): string {
  const ref = `#${pr.number} “${clip(pr.title, 60)}”`;
  const parts: string[] = [];
  const by = (k: ActivityKind) => items.filter((i) => i.kind === k);
  const changes = by('changes');
  const approved = by('approved');
  const reviewed = by('reviewed');
  const comments = by('comment');
  if (changes.length) {
    parts.push(`${names(changes.map((i) => i.author))} requested changes`);
  }
  if (approved.length) {
    parts.push(`${names(approved.map((i) => i.author))} approved`);
  }
  if (reviewed.length) {
    parts.push(`${names(reviewed.map((i) => i.author))} reviewed`);
  }
  if (comments.length === 1 && parts.length === 0) {
    return `@${comments[0].author} commented on ${ref}: “${clip(comments[0].body, 90)}”`;
  }
  if (comments.length) {
    parts.push(`${names(comments.map((i) => i.author))} left ${comments.length === 1 ? 'a comment' : `${comments.length} comments`}`);
  }
  if (!parts.length) {
    return `New activity on ${ref}.`;
  }
  const [first, ...rest] = parts;
  const firstSentence = /requested changes|approved|reviewed/.test(first) ? `${first} ${first.endsWith('requested changes') ? 'on ' : ''}${ref}` : `${first} on ${ref}`;
  return [firstSentence, ...rest].join('; ') + '.';
}
