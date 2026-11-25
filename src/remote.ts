import { execFile } from 'child_process';

export type HostKind = 'github' | 'gitlab';

export interface RemoteInfo {
  kind: HostKind;
  /** Host name without port, e.g. github.com or gitlab.example.com. */
  host: string;
  /** Full project path, e.g. owner/repo or group/subgroup/repo. */
  projectPath: string;
  /** Web address of the project. */
  webBase: string;
}

/**
 * Parses a git remote URL (https, ssh or scp-like) into its host and project path.
 * GitHub means github.com; GitLab means gitlab.com, any host containing "gitlab", or a host listed in `gitlabHosts`.
 */
export function parseRemoteUrl(url: string, gitlabHosts: string[] = []): RemoteInfo | undefined {
  const raw = url.trim();
  let host: string | undefined;
  let rest: string | undefined;
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/)(.+)$/.exec(raw);
  if (/^[a-z+]+:\/\//i.test(raw)) {
    try {
      const u = new URL(raw);
      host = u.hostname;
      rest = u.pathname;
    } catch {
      return undefined;
    }
  } else if (scp) {
    host = scp[1];
    rest = scp[2];
  }
  if (!host || !rest) {
    return undefined;
  }
  const projectPath = rest.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/, '');
  if (!projectPath.includes('/')) {
    return undefined;
  }
  const h = host.toLowerCase();
  const extra = gitlabHosts.map((g) => g.toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''));
  let kind: HostKind | undefined;
  if (h === 'github.com' || h === 'www.github.com' || h === 'ssh.github.com') {
    kind = 'github';
  } else if (h === 'gitlab.com' || h.includes('gitlab') || extra.includes(h)) {
    kind = 'gitlab';
  }
  if (!kind) {
    return undefined;
  }
  const webHost = kind === 'github' ? 'github.com' : h;
  return { kind, host: webHost, projectPath, webBase: `https://${webHost}/${projectPath}` };
}

function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd }, (err, stdout) => resolve(err ? '' : stdout.toString()));
  });
}

/** Reads the `origin` remote, or the first remote if there is no origin. */
export async function readRemote(root: string, gitlabHosts: string[]): Promise<RemoteInfo | undefined> {
  let url = (await git(['remote', 'get-url', 'origin'], root)).trim();
  if (!url) {
    const first = (await git(['remote'], root)).split('\n').map((s) => s.trim()).find((s) => s.length > 0);
    if (first) {
      url = (await git(['remote', 'get-url', first], root)).trim();
    }
  }
  return url ? parseRemoteUrl(url, gitlabHosts) : undefined;
}
