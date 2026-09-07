import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const notices = readFileSync(new URL('../THIRD_PARTY_NOTICES', import.meta.url), 'utf8');
const license = readFileSync(new URL('../LICENSE', import.meta.url), 'utf8');
const manifest = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { license?: string };

describe('packaged legal resources', () => {
  it('declares GPLv3-or-later with the approved VS Code host permission', () => {
    expect(manifest.license).toBe('SEE LICENSE IN LICENSE');
    expect(license).toContain('GNU GENERAL PUBLIC LICENSE');
    expect(license).toContain('Version 3, 29 June 2007');
    expect(license).toContain('Additional permission under GNU GPL version 3 section 7');
    expect(license).toContain('Microsoft Visual Studio Code');
    expect(license).toContain('vscode.git');
  });

  it('retains notices for every package embedded in the production bundle', () => {
    expect(notices).toContain('minimatch 10.2.6');
    expect(notices).toContain('brace-expansion 5.0.9');
    expect(notices).toContain('balanced-match 4.0.4');
    expect(notices).toContain('Blue Oak Model License');
    expect(notices).toContain('MIT terms');
  });
});
