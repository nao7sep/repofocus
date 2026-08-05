import { describe, expect, it } from 'vitest';
import { nativeVisibilityLimitIssue } from '../src/nativeVisibilityLimit';

describe('nativeVisibilityLimitIssue', () => {
  it('accepts a native limit equal to or above the repository count', () => {
    expect(nativeVisibilityLimitIssue(15, 15)).toBeUndefined();
    expect(nativeVisibilityLimitIssue(15, 20)).toBeUndefined();
  });

  it('explains a native limit that cannot represent every repository', () => {
    expect(nativeVisibilityLimitIssue(15, 10)).toBe(
      "VS Code's scm.repositories.visible setting (10) must be at least the monitored repository count (15).",
    );
  });

  it.each([-1, 1.5, Number.NaN])('rejects invalid native limit %s', limit => {
    expect(nativeVisibilityLimitIssue(1, limit)).toContain('must be a non-negative integer');
  });
});
