import * as vscode from 'vscode';
import { FileAnalysis } from './review';

export type Decision = 'approved' | 'changes';

interface SavedAnalysis {
  analysis: FileAnalysis;
  at: number;
  backend: string;
}

interface SavedDecision {
  hash: string;
  decision: Decision;
}

const ANALYSES = 'acr.analyses.v1';
const DECISIONS = 'acr.decisions.v1';
const SUMMARY = 'acr.summary.v1';
const MAX_ANALYSES = 1000;

/** Saved AI results (by file version) and per-file decisions, kept per workspace. */
export class Store {
  constructor(private readonly memento: vscode.Memento) {}

  getAnalysis(hash: string): SavedAnalysis | undefined {
    return this.memento.get<Record<string, SavedAnalysis>>(ANALYSES, {})[hash];
  }

  async saveAnalyses(entries: Array<{ hash: string; analysis: FileAnalysis }>, backend: string): Promise<void> {
    const all = { ...this.memento.get<Record<string, SavedAnalysis>>(ANALYSES, {}) };
    const at = Date.now();
    for (const e of entries) {
      all[e.hash] = { analysis: e.analysis, at, backend };
    }
    const keys = Object.keys(all);
    if (keys.length > MAX_ANALYSES) {
      keys
        .sort((a, b) => all[a].at - all[b].at)
        .slice(0, keys.length - MAX_ANALYSES)
        .forEach((k) => delete all[k]);
    }
    await this.memento.update(ANALYSES, all);
  }

  async clearAnalyses(): Promise<void> {
    await this.memento.update(ANALYSES, {});
    await this.memento.update(SUMMARY, undefined);
  }

  /** A decision only counts while the file is unchanged since it was made. */
  getDecision(filePath: string, hash: string): Decision | undefined {
    const d = this.memento.get<Record<string, SavedDecision>>(DECISIONS, {})[filePath];
    return d && d.hash === hash ? d.decision : undefined;
  }

  async setDecision(filePath: string, hash: string, decision: Decision | undefined): Promise<void> {
    const all = { ...this.memento.get<Record<string, SavedDecision>>(DECISIONS, {}) };
    if (decision) {
      all[filePath] = { hash, decision };
    } else {
      delete all[filePath];
    }
    await this.memento.update(DECISIONS, all);
  }

  getSummary(): { text: string; at: number; backend: string } | undefined {
    return this.memento.get(SUMMARY);
  }

  async saveSummary(text: string, backend: string): Promise<void> {
    await this.memento.update(SUMMARY, { text, at: Date.now(), backend });
  }
}
