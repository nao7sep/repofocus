import { minimatch } from 'minimatch';

export function matchesAlwaysShow(
  workspaceRelativePath: string,
  patterns: readonly string[],
): boolean {
  const path = workspaceRelativePath.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
  return patterns.some(pattern => {
    const normalizedPattern = pattern.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
    return minimatch(path, normalizedPattern, {
      dot: true,
      nocase: process.platform === 'win32',
    });
  });
}
