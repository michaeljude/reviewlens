export type CategoryId =
  | 'ui'
  | 'logic'
  | 'api'
  | 'types'
  | 'database'
  | 'test'
  | 'infra'
  | 'ci'
  | 'automation'
  | 'config'
  | 'docs'
  | 'other';

export const CATEGORIES: Array<{ id: CategoryId; label: string }> = [
  { id: 'ui', label: 'UI' },
  { id: 'logic', label: 'Business logic' },
  { id: 'api', label: 'API & networking' },
  { id: 'types', label: 'Shared types' },
  { id: 'database', label: 'Database' },
  { id: 'test', label: 'Unit tests' },
  { id: 'infra', label: 'Infra' },
  { id: 'ci', label: 'CI/CD' },
  { id: 'automation', label: 'Automation' },
  { id: 'config', label: 'Config & dependencies' },
  { id: 'docs', label: 'Docs' },
  { id: 'other', label: 'Other' },
];

export const CATEGORY_IDS = new Set<string>(CATEGORIES.map((c) => c.id));

export function categoryLabel(id: string | undefined): string {
  return CATEGORIES.find((c) => c.id === id)?.label ?? 'Not categorised yet';
}

const RULES: Array<{ id: CategoryId; patterns: RegExp[] }> = [
  {
    id: 'test',
    patterns: [
      /(^|\/)(__tests__|__mocks__|tests?|specs?|e2e)\//i,
      /\.(test|spec|e2e)\.[^/]+$/i,
      /_test\.(go|py|rb|exs?)$/i,
      /(^|\/)test_[^/]+\.py$/i,
      /Tests?\.(swift|kt|java|cs)$/,
    ],
  },
  {
    id: 'ci',
    patterns: [
      /^\.github\/workflows\//,
      /(^|\/)\.gitlab-ci\.ya?ml$/,
      /^\.gitlab\/ci\//,
      /(^|\/)Jenkinsfile$/,
      /^\.circleci\//,
      /(^|\/)azure-pipelines\.ya?ml$/,
      /(^|\/)bitbucket-pipelines\.ya?ml$/,
      /^\.buildkite\//,
      /(^|\/)codemagic\.ya?ml$/,
      /(^|\/)eas\.json$/,
      /(^|\/)fastlane\//,
    ],
  },
  {
    id: 'infra',
    patterns: [
      /(^|\/)Dockerfile[^/]*$/,
      /(^|\/)docker-compose[^/]*\.ya?ml$/,
      /\.tf(vars)?$/,
      /(^|\/)(terraform|k8s|kubernetes|helm|charts|infra|infrastructure|deploy|deployment)\//i,
      /(^|\/)serverless\.ya?ml$/,
    ],
  },
  {
    id: 'database',
    patterns: [/(^|\/)migrations?\//i, /\.sql$/i, /(^|\/)schema\.prisma$/, /(^|\/)prisma\/[^/]+\.prisma$/],
  },
  {
    id: 'automation',
    patterns: [/(^|\/)scripts?\//i, /\.(sh|bash|zsh|ps1)$/i, /(^|\/)Makefile$/, /(^|\/)\.husky\//],
  },
  {
    id: 'docs',
    patterns: [/\.(md|mdx|rst|adoc)$/i, /(^|\/)docs?\//i, /(^|\/)(LICENSE|CHANGELOG)[^/]*$/i],
  },
  {
    id: 'config',
    patterns: [
      /(^|\/)package\.json$/,
      /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Podfile(\.lock)?|Gemfile(\.lock)?|Cargo\.lock|poetry\.lock|go\.sum|pubspec\.lock)$/,
      /(^|\/)tsconfig[^/]*\.json$/,
      /(^|\/)\.(eslintrc|prettierrc|babelrc|editorconfig|nvmrc|npmrc)[^/]*$/,
      /(^|\/)(babel|vite|webpack|metro|jest|vitest|rollup|tailwind|postcss|next|nuxt)\.config\.[^/]+$/,
      /(^|\/)(app\.json|app\.config\.[jt]s|pubspec\.yaml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|gradle\.properties|Info\.plist|AndroidManifest\.xml)$/,
      /(^|\/)\.env(\.[^/]*)?$/,
    ],
  },
];

/** Category decided by path rules alone, or undefined when the AI should decide. */
export function ruleCategory(filePath: string): CategoryId | undefined {
  for (const rule of RULES) {
    if (rule.patterns.some((p) => p.test(filePath))) {
      return rule.id;
    }
  }
  return undefined;
}

const SKIP_AI = [
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Podfile\.lock|Gemfile\.lock|Cargo\.lock|poetry\.lock|go\.sum|pubspec\.lock)$/,
  /\.min\.(js|css)$/,
  /\.(snap|map)$/,
  /(^|\/)(dist|build|out|\.next|coverage)\//,
];

/** Files whose diffs are not worth sending to the AI (lockfiles, build output, snapshots). */
export function skipForAi(filePath: string): boolean {
  return SKIP_AI.some((p) => p.test(filePath));
}

/** Area by the first configured prefix that matches. */
export function areaFor(filePath: string, areas: Record<string, string[]>): string {
  const p = filePath.toLowerCase();
  for (const [name, prefixes] of Object.entries(areas)) {
    for (const prefix of prefixes) {
      const pre = prefix.toLowerCase().replace(/^\.?\//, '');
      if (pre && p.startsWith(pre)) {
        return name;
      }
    }
  }
  return 'Other';
}
