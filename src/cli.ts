/** Helpers for the CLI backends that don't depend on the VS Code API (so they can be unit tested). */

export class BackendError extends Error {}

/**
 * The Cursor agent CLI refuses to run in a folder you haven't trusted yet, and asks interactively instead.
 * ReviewLens never trusts a folder for you: trusting lets the agent run code there.
 */
export class WorkspaceTrustError extends BackendError {}

/** Whether a failed CLI run stopped at the Cursor agent's workspace trust prompt. */
export function isWorkspaceTrustPrompt(stdout: string, stderr: string): boolean {
  return /workspace trust required/i.test(`${stdout}\n${stderr}`);
}

export function workspaceTrustMessage(label: string): string {
  return `${label}: it hasn't been allowed to work in this folder yet. Run it once in a terminal here and choose to trust the folder, then run the review again.`;
}

/** The CLIs print a JSON envelope whose `result` field holds the model's reply, or the error when `is_error` is set. */
export function unwrapCliOutput(stdout: string): string {
  const trimmed = stdout.trim();
  let env: unknown;
  try {
    env = JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
  if (env && typeof env === 'object') {
    const e = env as { result?: unknown; is_error?: unknown };
    if (e.is_error === true) {
      throw new BackendError(typeof e.result === 'string' && e.result ? e.result : 'The CLI reported an error.');
    }
    if (typeof e.result === 'string') {
      return e.result;
    }
  }
  return trimmed;
}

/** A short, readable message for a CLI run that failed. */
export function cliErrorMessage(label: string, stdout: string, stderr: string, code: number | null): string {
  let detail = '';
  try {
    unwrapCliOutput(stdout);
  } catch (e) {
    if (e instanceof BackendError) {
      detail = e.message;
    }
  }
  if (!detail) {
    detail = (stderr || stdout).trim().split('\n').slice(-3).join(' ').slice(0, 300);
  }
  let msg = `${label}: ${detail || `exited with code ${code}`}`;
  if (/authenticat|log ?in|sign ?in|oauth|api key/i.test(detail)) {
    msg += ' Sign in again by running the CLI in a terminal, then retry.';
  }
  return msg;
}
