export function nativeVisibilityLimitIssue(
  repositoryCount: number,
  configuredLimit: number,
): string | undefined {
  if (!Number.isSafeInteger(configuredLimit) || configuredLimit < 0) {
    return `VS Code's scm.repositories.visible setting must be a non-negative integer; received ${configuredLimit}.`;
  }
  if (repositoryCount > configuredLimit) {
    return `VS Code's scm.repositories.visible setting (${configuredLimit}) must be at least the monitored repository count (${repositoryCount}).`;
  }
  return undefined;
}
