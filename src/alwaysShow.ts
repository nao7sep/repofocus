import { minimatch } from 'minimatch';

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
  const options = { dot: true, nocase: process.platform === 'win32' } as const;
  const paths = candidates(reportedPath);
  return patterns.some(pattern => {
    const normalizedPattern = normalize(pattern);
    return paths.some(path => minimatch(path, normalizedPattern, options));
  });
}
