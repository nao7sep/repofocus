// Test-only bridge into a disposable copy of VS Code. Never patch the cached or
// installed host. Fail closed when the native action's structure changes: the
// integration gate must not silently fall back to RepoFocus's own ledger.
import { constants } from 'node:fs';
import { cp, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';

export async function prepareOracleHost(executable, destination) {
  const root = process.platform === 'darwin'
    ? dirname(dirname(dirname(executable))) : dirname(executable);
  const copy = join(destination, process.platform === 'darwin' ? 'Oracle Code.app' : 'vscode');
  await cp(root, copy, { recursive: true, mode: constants.COPYFILE_FICLONE });
  const app = process.platform === 'darwin' ? join(copy, 'Contents', 'Resources', 'app') : join(copy, 'resources', 'app');
  const path = join(app, 'out', 'vs', 'workbench', 'workbench.desktop.main.js');
  await writeFile(path, instrumentWorkbench(await readFile(path, 'utf8')));
  return join(copy, relative(root, executable));
}

export function instrumentWorkbench(source) {
  const action = /var (\w+)=class extends \w+\{constructor\((\w+)\)\{super\(\{id:`workbench\.scm\.action\.toggleRepositoryVisibility\.\$\{\2\.provider\.id\}`[\s\S]*?run\((\w+)\)\{\3\.get\((\w+)\)\.toggleVisibility\(this\.repository\)\}\}/g;
  const matches = [...source.matchAll(action)];
  if (matches.length !== 1) throw new Error('Native visibility oracle cannot locate the host action. Update the test bridge for this VS Code build.');
  const match = matches[0];
  // CommandsRegistry is the registry used by the nearby SCM registrations.
  const registry = /([\w$]+)\.registerCommand\(/.exec(source.slice(Math.max(0, match.index - 100_000), match.index))?.[1];
  if (!registry) throw new Error('Native visibility oracle cannot locate CommandsRegistry.');
  const accessor = match[3], service = match[4];
  const bridge = `${registry}.registerCommand('repofocus.test.nativeState',a=>{const s=a.get(${service});const row=r=>({id:r.provider.id,uri:r.provider.rootUri?.toString()});return {visible:s.visibleRepositories.map(row),selected:s.focusedRepository?row(s.focusedRepository):null}});`;
  const suppression = `${registry}.registerCommand('repofocus.test.suppressToggle',(_a,id)=>{globalThis.__repofocusSuppressedProvider=id});`;
  const original = `${accessor}.get(${service}).toggleVisibility(this.repository)`;
  const instrumented = match[0].replace(original, `if(globalThis.__repofocusSuppressedProvider===this.repository.provider.id)return;${original}`);
  source = source.slice(0, match.index) + bridge + suppression + instrumented + source.slice(match.index + match[0].length);
  return source;
}
