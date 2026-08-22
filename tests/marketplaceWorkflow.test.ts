import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync('.github/workflows/marketplace-publish.yml', 'utf8');

describe('Marketplace publication workflow', () => {
  it('treats the manual tag as data and accepts only an exact release tag', () => {
    expect(workflow.match(/\$\{\{\s*inputs\.tag\s*\}\}/g)).toHaveLength(1);
    expect(workflow).toContain('RELEASE_TAG: ${{ inputs.tag }}');
    expect(workflow).toContain(
      '[[ ! "$RELEASE_TAG" =~ ^v(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$ ]]',
    );
    expect(workflow).toContain('gh release download "$RELEASE_TAG"');
  });

  it('loads repository-owned publishing tools from the requested exact tag', () => {
    expect(workflow).toContain('ref: ${{ env.RELEASE_TAG }}');
    expect(workflow).toContain('git tag --points-at HEAD --list "$RELEASE_TAG"');
    expect(workflow).toContain('[[ "v$manifest_version" != "$RELEASE_TAG" ]]');
    expect(workflow.indexOf('Verify exact tag and manifest version'))
      .toBeLessThan(workflow.indexOf('npm ci'));
  });
});
