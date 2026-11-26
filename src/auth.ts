import * as vscode from 'vscode';
import { RemoteInfo } from './remote';

/**
 * Credentials for GitHub and GitLab.
 * GitHub: the editor's built-in GitHub sign-in when available, otherwise a personal access token.
 * GitLab: a personal access token. Tokens are kept in the editor's secret storage, never in settings.
 */
export class HostAuth {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  private key(r: RemoteInfo): string {
    return `reviewlens.token.${r.kind}.${r.host}`;
  }

  /** Returns a token, or undefined when the user isn't signed in (and `interactive` is false) or cancels. */
  async token(r: RemoteInfo, interactive: boolean): Promise<string | undefined> {
    const saved = await this.secrets.get(this.key(r));
    if (saved) {
      return saved;
    }
    if (r.kind === 'github') {
      try {
        const session = await vscode.authentication.getSession('github', ['repo'], interactive ? { createIfNone: true } : { silent: true });
        if (session) {
          return session.accessToken;
        }
        if (!interactive) {
          return undefined;
        }
      } catch (e) {
        const msg = (e as Error).message ?? '';
        // Some editors don't ship GitHub sign-in; fall back to a token. A cancelled sign-in stops here.
        if (!/no authentication provider|not found|not registered/i.test(msg)) {
          return undefined;
        }
      }
    }
    return interactive ? this.promptToken(r) : undefined;
  }

  async promptToken(r: RemoteInfo): Promise<string | undefined> {
    const label = r.kind === 'github' ? 'GitHub' : 'GitLab';
    const where =
      r.kind === 'github'
        ? 'github.com/settings/tokens (fine-grained: Pull requests read and write, Contents read-only)'
        : `${r.host}/-/user_settings/personal_access_tokens (scope: api; read_api only lets you read)`;
    const value = await vscode.window.showInputBox({
      title: `${label} access token for ${r.host}`,
      prompt: `Create one at ${where}. It is kept in the editor's secure storage.`,
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() ? undefined : 'Paste a token.'),
    });
    const token = value?.trim();
    if (!token) {
      return undefined;
    }
    await this.secrets.store(this.key(r), token);
    return token;
  }

  async forget(r: RemoteInfo): Promise<void> {
    await this.secrets.delete(this.key(r));
  }
}
