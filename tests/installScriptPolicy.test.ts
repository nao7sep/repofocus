import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('reviews each locked install-script identity with an exact boolean policy', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    allowScripts: Record<string, boolean>;
  };
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8')) as {
    packages: Record<string, { version: string; resolved?: string; hasInstallScript?: boolean }>;
  };

  // Include optional packages for other platforms; the lock owns the install inventory.
  const identities = Object.entries(lock.packages)
    .filter(([, entry]) => entry.hasInstallScript)
    .map(([path, entry]) => {
      const name = path.split('node_modules/').at(-1)!;
      const basename = name.split('/').at(-1)!;
      // npm matches registry policy against the tarball source, including the scope.
      expect(entry.resolved).toBe(`https://registry.npmjs.org/${name}/-/${basename}-${entry.version}.tgz`);
      return `${name}@${entry.version}`;
    });

  expect(Object.keys(manifest.allowScripts).sort()).toEqual([...new Set(identities)].sort());
  for (const decision of Object.values(manifest.allowScripts)) {
    expect(typeof decision).toBe('boolean');
  }
});
