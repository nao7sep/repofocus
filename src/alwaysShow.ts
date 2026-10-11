import { Minimatch } from 'minimatch';

export const MAX_ALWAYS_SHOW_PATTERNS = 100;
export const MAX_ALWAYS_SHOW_PATTERN_LENGTH = 512;

function normalize(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
}

/**
 * Candidate strings a pattern may match for one repository: the path VS Code
 * reported, and its final segment (the repository's own directory name).
 *
 * A repository INSIDE a workspace folder reports a workspace-relative path
 * (`clients/api`). A repository that IS a workspace folder reports its absolute
 * path, which is machine-specific and useless in shared settings, so its
 * directory name is the portable candidate. `alwaysShow: ["repofocus"]` works in
 * both workspace shapes, and `clients/*` matches nested repositories.
 *
 * The deliberate trade: two repositories with the same directory name in
 * different roots both match a bare-name pattern. That is usually the intent —
 * a name names a repository, not a location — and anyone who needs to separate
 * them can write a longer path, which only the intended one can satisfy.
 */
function candidates(reportedPath: string): string[] {
  const path = normalize(reportedPath);
  const name = path.split('/').filter(Boolean).pop();
  return name && name !== path ? [path, name] : [path];
}

/** Pure compiled matcher; production uses it only inside the isolated worker. */
export interface AlwaysShowConfiguration {
  readonly patternCount: number;
  readonly matches: (reportedPath: string) => boolean;
  readonly valid: boolean;
}

export interface AlwaysShowPatterns {
  readonly patterns: readonly string[];
  readonly patternCount: number;
  readonly valid: boolean;
}

/**
 * Matching follows how the platform's disks usually treat names: Windows and
 * macOS ignore upper and lower case, Linux does not.
 */
function ignoresCase(platform: NodeJS.Platform): boolean {
  return platform === 'win32' || platform === 'darwin';
}

export function validateAlwaysShowPatterns(value: unknown): AlwaysShowPatterns {
  // An invalid set reads as its built-in per config-sets-conventions; the
  // caller logs the warning.
  if (!Array.isArray(value)) {
    return { patternCount: 0, patterns: [], valid: false };
  }
  const patterns = value as readonly unknown[];
  if (
    patterns.length > MAX_ALWAYS_SHOW_PATTERNS
    || patterns.some(pattern => (
      typeof pattern !== 'string' || pattern.length > MAX_ALWAYS_SHOW_PATTERN_LENGTH
    ))
  ) {
    // Settings normally reject this shape, but a hand-edited or synced value can
    // bypass validation; it is never compiled.
    return { patternCount: patterns.length, patterns: [], valid: false };
  }
  return { patternCount: patterns.length, patterns: [...patterns] as string[], valid: true };
}

export function compileAlwaysShowConfiguration(
  value: unknown,
  platform: NodeJS.Platform = process.platform,
): AlwaysShowConfiguration {
  const { patterns, patternCount, valid } = validateAlwaysShowPatterns(value);
  if (!valid) return { patternCount, valid, matches: () => false };
  // Brace expansion is not part of the documented pattern surface and can
  // multiply one setting into a very large generated pattern set.
  const options = { dot: true, nobrace: true, nocase: ignoresCase(platform) } as const;
  const matchers = patterns.map(pattern => new Minimatch(normalize(pattern), options));
  return {
    patternCount,
    valid: true,
    matches: reportedPath => {
      const paths = candidates(reportedPath);
      return matchers.some(matcher => paths.some(path => matcher.match(path)));
    },
  };
}
