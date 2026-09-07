import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const notices = readFileSync(new URL('../THIRD_PARTY_NOTICES', import.meta.url), 'utf8');

describe('packaged legal resources', () => {
  it('retains notices for every package embedded in the production bundle', () => {
    expect(notices).toContain('minimatch 10.2.6');
    expect(notices).toContain('brace-expansion 5.0.9');
    expect(notices).toContain('balanced-match 4.0.4');
    expect(notices).toContain('Blue Oak Model License');
    expect(notices).toContain('MIT terms');
  });
});
