import { Minimatch } from 'minimatch';

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

export function validateAlwaysShowPatterns(value: unknown): AlwaysShowPatterns {
  // An invalid set reads as the built-in empty list rather than half-applying;
  // the caller logs the warning.
  if (!Array.isArray(value)) {
    return { patternCount: 0, patterns: [], valid: false };
  }
  const patterns = value as readonly unknown[];
  if (patterns.some(pattern => typeof pattern !== 'string')) {
    // Settings normally reject this shape, but a hand-edited or synced value can
    // bypass validation; it is never compiled.
    return { patternCount: patterns.length, patterns: [], valid: false };
  }
  return { patternCount: patterns.length, patterns: [...patterns] as string[], valid: true };
}

export function compileAlwaysShowConfiguration(value: unknown): AlwaysShowConfiguration {
  const { patterns, patternCount, valid } = validateAlwaysShowPatterns(value);
  if (!valid) return { patternCount, valid, matches: () => false };
  // Brace expansion is not part of the documented pattern surface and can
  // multiply one setting into a very large generated pattern set. Case is
  // ignored on every platform: a pattern only keeps repositories visible, so a
  // differently cased match on a case-sensitive disk shows an extra clean
  // repository rather than hiding one (developer decision).
  const options = { dot: true, nobrace: true, nocase: true } as const;
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
