import { describe, expect, it } from 'vitest';
import { compileAlwaysShowConfiguration } from '../src/alwaysShow';

function matchesAlwaysShow(path: string, patterns: readonly string[]): boolean {
  return compileAlwaysShowConfiguration(patterns).matches(path);
}

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
    expect(matchesAlwaysShow('clients/customer-a', ['clients\\customer-*'])).toBe(true);
  });

  // Normalization is platform-neutral, so absolute Windows paths and patterns
  // behave the same on every test host.
  it('matches absolute Windows paths with either separator or drive-letter case', () => {
    expect(matchesAlwaysShow('C:\\work\\repofocus', ['C:\\work\\*'])).toBe(true);
    expect(matchesAlwaysShow('C:\\work\\repofocus', ['c:/work/repofocus'])).toBe(true);
    expect(matchesAlwaysShow('C:\\work\\repofocus', ['D:/work/*'])).toBe(false);
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

  it('reuses one compiled matcher across repository state events', () => {
    const { matches } = compileAlwaysShowConfiguration(['clients/**', 'repofocus']);

    expect(matches('clients/api')).toBe(true);
    expect(matches('/work/repofocus')).toBe(true);
    expect(matches('company')).toBe(false);
  });

  it('reads synced configuration beyond the pattern bounds as the empty built-in', () => {
    const tooMany = Array.from({ length: 101 }, (_, index) => `repo-${index}`);
    const tooLong = ['x'.repeat(513)];

    expect(compileAlwaysShowConfiguration(tooMany).matches('repo-0')).toBe(false);
    expect(compileAlwaysShowConfiguration(tooLong).matches('x'.repeat(513))).toBe(false);
  });

  it.each([
    null,
    'repofocus',
    { repository: 'repofocus' },
    [42],
    ['repofocus', null],
  ])('reads malformed host configuration as the empty built-in: %j', value => {
    const configuration = compileAlwaysShowConfiguration(value);

    expect(configuration.valid).toBe(false);
    expect(configuration.matches('repofocus')).toBe(false);
  });

  it('ignores case on every platform', () => {
    const configuration = compileAlwaysShowConfiguration(['Alpha', 'Clients/*']);

    expect(configuration.matches('alpha')).toBe(true);
    expect(configuration.matches('/work/ALPHA')).toBe(true);
    expect(configuration.matches('clients/api')).toBe(true);
  });

  // minimatch takes its Windows root rules from the running process, so only a
  // Windows host exercises them; elsewhere this is reported as skipped.
  it.skipIf(process.platform !== 'win32')('treats extended-length Windows paths as their drive path on a Windows host', () => {
    expect(matchesAlwaysShow('\\\\?\\C:\\work\\repofocus', ['C:/work/*'])).toBe(true);
    expect(matchesAlwaysShow('C:\\work\\repofocus', ['//?/C:/work/*'])).toBe(true);
  });

  it('retains only the aggregate count for a malformed array', () => {
    const configuration = compileAlwaysShowConfiguration(['repofocus', null]);

    expect(configuration.patternCount).toBe(2);
    expect(configuration.valid).toBe(false);
  });
});
