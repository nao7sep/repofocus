import { describe, expect, it } from 'vitest';
import type { GitRepository } from '../src/gitApi';
import { establishVisibilityBaseline } from '../src/visibilityBaseline';

function repository(name: string, selected: () => boolean): GitRepository {
  return {
    rootUri: { fsPath: `/${name}`, toString: () => `file:///${name}` },
    ui: { get selected() { return selected(); }, onDidChange: () => ({ dispose() {} }) },
  } as unknown as GitRepository;
}

const fastTimings = {
  modeSettleMilliseconds: 0,
  probeMilliseconds: 1,
  selectionTimeoutMilliseconds: 1,
} as const;

describe('establishVisibilityBaseline', () => {
  it('discovers command identity from reversible focus changes', async () => {
    const names = ['alpha', 'beta', 'gamma'];
    let selectedName = 'beta';
    const visible = new Set(names);
    const repositories = names.map(name => repository(name, () => selectedName === name));
    const targets = new Map([
      ['toggle.scm0', 'gamma'],
      ['toggle.scm1', 'alpha'],
      ['toggle.scm2', 'beta'],
    ]);
    const commands = [...targets.keys()];
    const baseline = await establishVisibilityBaseline(
      repositories,
      commands,
      command => {
        if (command.endsWith('.single')) {
          const first = names.find(name => visible.has(name)) ?? names[0];
          visible.clear();
          visible.add(first);
          selectedName = first;
        } else if (command.endsWith('.multiple')) {
          for (const name of names) visible.add(name);
        } else if (targets.has(command)) {
          const target = targets.get(command)!;
          if (visible.delete(target)) {
            if (selectedName === target) selectedName = names.find(name => visible.has(name)) ?? target;
          } else {
            visible.add(target);
          }
        }
        return Promise.resolve();
      },
      fastTimings,
    );

    expect(baseline.mappings.map(mapping => [mapping.repository.rootUri.toString(), mapping.command])).toEqual([
      ['file:///alpha', 'toggle.scm1'],
      ['file:///beta', 'toggle.scm2'],
      ['file:///gamma', 'toggle.scm0'],
    ]);
    expect(baseline.hiddenRepositories.map(item => item.rootUri.toString())).toEqual([
      'file:///alpha',
      'file:///beta',
    ]);
    expect([...visible]).toEqual(['gamma']);
  });

  it('rejects when no command changes the focused repository', async () => {
    const repositories = [
      repository('alpha', () => true),
      repository('beta', () => false),
    ];
    await expect(establishVisibilityBaseline(
      repositories,
      ['toggle.scm0', 'toggle.scm1'],
      () => Promise.resolve(),
      fastTimings,
    )).rejects.toThrow('No native visibility command matched');
  });

  it('wraps a native command failure', async () => {
    const alpha = repository('alpha', () => true);
    await expect(establishVisibilityBaseline(
      [alpha],
      ['toggle.scm0'],
      command => command.endsWith('.single')
        ? Promise.reject(new Error('unsupported'))
        : Promise.resolve(),
      fastTimings,
    )).rejects.toThrow('could not restore the native all-visible state');
  });

  it('reports that recovery established an all-visible state after a probe failure', async () => {
    const repositories = [
      repository('alpha', () => true),
      repository('beta', () => false),
    ];
    const promise = establishVisibilityBaseline(
      repositories,
      ['toggle.scm0', 'toggle.scm1'],
      () => Promise.resolve(),
      fastTimings,
    );

    await expect(promise).rejects.toMatchObject({ recoveredToAllVisible: true });
  });
});
