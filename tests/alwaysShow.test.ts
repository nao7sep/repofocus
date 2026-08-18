import { describe, expect, it } from 'vitest';
import { matchesAlwaysShow } from '../src/alwaysShow';

describe('matchesAlwaysShow', () => {
  it.each([
    ['company', ['company']],
    ['clients/customer-a', ['clients/*']],
    ['clients/internal/tools', ['clients/**/tools']],
    ['.internal', ['.*']],
    ['company', ['./company']],
  ])('matches %s against workspace-relative patterns', (path, patterns) => {
    expect(matchesAlwaysShow(path, patterns)).toBe(true);
  });

  it('normalizes Windows separators', () => {
    expect(matchesAlwaysShow('clients\\customer-a', ['clients/customer-*'])).toBe(true);
  });

  // A repository that IS a workspace folder has no relative form — VS Code hands
  // back its absolute path — so a bare name is the only pattern a person can
  // reasonably write for it. Matching the final path segment as well as the whole
  // path is what makes `alwaysShow` usable in a multi-root workspace at all.
  it.each([
    ['/Users/someone/work/repofocus', ['repofocus']],
    ['C:\\work\\repofocus', ['repofocus']],
    ['/Users/someone/work/repofocus', ['repo*']],
    ['clients/customer-a', ['customer-a']],
  ])('matches %s by its repository name', (path, patterns) => {
    expect(matchesAlwaysShow(path, patterns)).toBe(true);
  });

  // The accepted cost of matching on name: same-named repositories in different
  // roots both match a bare-name pattern. Usually the intent — a name names a
  // repository, not a location — and a longer path separates them when it is not.
  it('matches same-named repositories in different roots, by design', () => {
    expect(matchesAlwaysShow('/a/shared', ['shared'])).toBe(true);
    expect(matchesAlwaysShow('/b/shared', ['shared'])).toBe(true);
    // A longer pattern still discriminates.
    expect(matchesAlwaysShow('/a/shared', ['/a/shared'])).toBe(true);
    expect(matchesAlwaysShow('/b/shared', ['/a/shared'])).toBe(false);
  });

  it('does not match unrelated repositories or parent segments', () => {
    expect(matchesAlwaysShow('clients/customer-a', ['company', 'other-*'])).toBe(false);
    // A parent segment alone is not a repository and must not match one.
    expect(matchesAlwaysShow('clients/customer-a', ['clients'])).toBe(false);
  });

  it('returns false for an empty pattern list', () => {
    expect(matchesAlwaysShow('company', [])).toBe(false);
  });
});
