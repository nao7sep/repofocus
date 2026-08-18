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

  it('does not match unrelated repositories or parent segments', () => {
    expect(matchesAlwaysShow('clients/customer-a', ['customer-*', 'company'])).toBe(false);
  });

  it('returns false for an empty pattern list', () => {
    expect(matchesAlwaysShow('company', [])).toBe(false);
  });
});
