import { Minimatch } from 'minimatch';

export const MAX_ALWAYS_SHOW_PATTERNS = 100;
export const MAX_ALWAYS_SHOW_PATTERN_LENGTH = 512;

function normalize(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
}

/**
 * Candidate strings a pattern may match for one repository.
 *
 * A repository sitting INSIDE a workspace folder has a workspace-relative path
 * (`clients/api`), which is what patterns were originally written against. A
 * repository that IS a workspace folder has no relative form at all — VS Code
 * returns its absolute path — so the only pattern that could ever match it would
 * be an absolute one, which is machine-specific and useless in shared settings.
 *
 * So each repository offers two candidates: the path VS Code reported, and its
 * final segment (the repository's own directory name). `alwaysShow: ["repofocus"]`
 * then works in both workspace shapes, and `clients/*` keeps working exactly as
 * before.
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

export function matchesAlwaysShow(
  reportedPath: string,
  patterns: readonly string[],
): boolean {
  return createAlwaysShowMatcher(patterns)(reportedPath);
}

/** Compile configuration once; repository state events only perform matches. */
export interface AlwaysShowConfiguration {
  readonly patternCount: number;
  readonly matches: (reportedPath: string) => boolean;
  readonly valid: boolean;
}

export function compileAlwaysShowConfiguration(value: unknown): AlwaysShowConfiguration {
  if (!Array.isArray(value)) {
    return { patternCount: 0, matches: () => true, valid: false };
  }
  const patterns = value as readonly unknown[];
  if (
    patterns.length > MAX_ALWAYS_SHOW_PATTERNS
    || patterns.some(pattern => (
      typeof pattern !== 'string' || pattern.length > MAX_ALWAYS_SHOW_PATTERN_LENGTH
    ))
  ) {
    // Settings normally reject this shape. If a hand-edited or synced value
    // bypasses validation, fail visible instead of compiling unbounded input or
    // hiding repositories whose exemption could not be evaluated.
    return { patternCount: patterns.length, matches: () => true, valid: false };
  }
  const validPatterns = patterns as readonly string[];
  // Brace expansion is not part of the documented pattern surface and can
  // multiply one setting into a very large generated pattern set.
  const options = { dot: true, nobrace: true, nocase: process.platform === 'win32' } as const;
  const matchers = validPatterns.map(pattern => new Minimatch(normalize(pattern), options));
  return {
    patternCount: validPatterns.length,
    valid: true,
    matches: reportedPath => {
      const paths = candidates(reportedPath);
      return matchers.some(matcher => paths.some(path => matcher.match(path)));
    },
  };
}

export function createAlwaysShowMatcher(value: unknown): (reportedPath: string) => boolean {
  return compileAlwaysShowConfiguration(value).matches;
}
