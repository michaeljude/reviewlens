import { spawn } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { BackendError, cliErrorMessage, unwrapCliOutput } from './cli';

export type BackendId = 'copilot' | 'cursor' | 'claude';

export interface BackendOptions {
  cwd: string;
  timeoutSeconds: number;
  cursorCommand: string;
  claudeCommand: string;
}

export const BACKEND_LABELS: Record<BackendId, string> = {
  copilot: 'GitHub Copilot',
  cursor: 'Cursor agent',
  claude: 'Claude Code',
};

export function isCursor(): boolean {
  return vscode.env.appName.toLowerCase().includes('cursor');
}

export function resolveBackend(setting: string): BackendId {
  if (setting === 'copilot' || setting === 'cursor' || setting === 'claude') {
    return setting;
  }
  return isCursor() ? 'cursor' : 'copilot';
}

export { BackendError };

export async function runBackend(
  id: BackendId,
  prompt: string,
  opts: BackendOptions,
  token: vscode.CancellationToken,
): Promise<string> {
  switch (id) {
    case 'copilot':
      return runCopilot(prompt, token);
    case 'cursor':
      return runCli(opts.cursorCommand, ['-p', '--output-format', 'json', prompt], undefined, 'Cursor agent CLI', opts, token);
    case 'claude':
      return runCli(opts.claudeCommand, ['-p', '--output-format', 'json'], prompt, 'Claude Code CLI', opts, token);
  }
}

async function runCopilot(prompt: string, token: vscode.CancellationToken): Promise<string> {
  const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
  if (models.length === 0) {
    throw new BackendError(
      isCursor()
        ? 'Copilot models are not available in Cursor. Pick the Cursor agent or Claude Code backend in settings.'
        : 'No Copilot models found. Install and sign in to GitHub Copilot, or pick another backend in settings.',
    );
  }
  const model = models[0];
  const response = await model.sendRequest(
    [vscode.LanguageModelChatMessage.User(prompt)],
    { justification: 'ReviewLens explains your uncommitted changes when you run a review.' },
    token,
  );
  let text = '';
  for await (const chunk of response.text) {
    text += chunk;
  }
  return text;
}

/** Editors started from the Dock often miss shell PATH entries where these CLIs live. */
function extendedPath(): string {
  const home = os.homedir();
  const extra = [path.join(home, '.local', 'bin'), path.join(home, '.cursor', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
  const current = (process.env.PATH ?? '').split(path.delimiter);
  return [...current, ...extra.filter((p) => !current.includes(p))].join(path.delimiter);
}

function runCli(
  command: string,
  args: string[],
  stdin: string | undefined,
  label: string,
  opts: BackendOptions,
  token: vscode.CancellationToken,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: { ...process.env, PATH: extendedPath() },
      shell: process.platform === 'win32',
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (fn: () => void) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        sub.dispose();
        fn();
      }
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new BackendError(`${label} did not answer within ${opts.timeoutSeconds} seconds.`)));
    }, opts.timeoutSeconds * 1000);
    const sub = token.onCancellationRequested(() => {
      child.kill();
      finish(() => reject(new vscode.CancellationError()));
    });
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', (err: NodeJS.ErrnoException) => {
      const msg =
        err.code === 'ENOENT'
          ? `Couldn't find the ${label} (\`${command}\`). Install it or set its command in the ReviewLens settings.`
          : `${label} failed to start: ${err.message}`;
      finish(() => reject(new BackendError(msg)));
    });
    child.on('close', (code) => {
      finish(() => {
        if (code !== 0) {
          reject(new BackendError(cliErrorMessage(label, stdout, stderr, code)));
          return;
        }
        try {
          resolve(unwrapCliOutput(stdout));
        } catch {
          reject(new BackendError(cliErrorMessage(label, stdout, stderr, code)));
        }
      });
    });
    if (stdin !== undefined) {
      child.stdin.write(stdin);
    }
    child.stdin.end();
  });
}
