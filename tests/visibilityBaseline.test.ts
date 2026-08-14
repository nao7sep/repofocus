import { describe, expect, it } from 'vitest';
import type { GitRepository } from '../src/gitApi';
import {
  probeVisibilityMappings,
  RepositoriesAlreadyHiddenError,
  type VisibilityProbeLedger,
} from '../src/visibilityBaseline';

function repository(name: string, selected: () => boolean): GitRepository {
  return {
    rootUri: { fsPath: `/${name}`, toString: () => `file:///${name}` },
    ui: { get selected() { return selected(); }, onDidChange: () => ({ dispose() {} }) },
  } as unknown as GitRepository;
}

const fastTimings = { probeMilliseconds: 1, selectionTimeoutMilliseconds: 1 } as const;

/**
 * Models the native behaviour measured in the Extension Host: hiding the
 * focused repository moves focus to another visible one, hiding the last
 * visible repository moves focus nowhere and leaves the stale value, and
 * revealing a hidden repository produces no focus change at all.
 */
function nativeWorld(names: readonly string[], hiddenAtStart: readonly string[] = []) {
  const visible = new Set(names.filter(name => !hiddenAtStart.includes(name)));
  let selectedName = [...visible][0];
  const targets = new Map(names.map((name, index) => [`toggle.scm${index}`, name]));
  const repositories = names.map(name => repository(name, () => selectedName === name));
  const execute = (command: string): Promise<void> => {
    const target = targets.get(command);
    if (target !== undefined) {
      if (visible.delete(target)) {
        if (selectedName === target) {
          selectedName = names.find(name => visible.has(name)) ?? selectedName;
        }
      } else {
        visible.add(target);
      }
    }
    return Promise.resolve();
  };
  return { visible, repositories, commands: [...targets.keys()], execute };
}

function ledgerOver(execute: (command: string) => Promise<void>) {
  const hidden = new Set<string>();
  const ledger: VisibilityProbeLedger = {
    hide: async command => { hidden.add(command); await execute(command); },
    reveal: async command => { await execute(command); hidden.delete(command); },
  };
  return { ledger, hidden };
}

describe('probeVisibilityMappings', () => {
  it('maps every repository from an all-visible state without touching configuration', async () => {
    const world = nativeWorld(['alpha', 'beta', 'gamma']);
    const executed: string[] = [];
    const { ledger, hidden } = ledgerOver(async command => {
      executed.push(command);
      await world.execute(command);
    });

    const mappings = await probeVisibilityMappings(
      world.repositories,
      world.commands,
      ledger,
      fastTimings,
    );

    expect(mappings.map(m => [m.repository.rootUri.toString(), m.command])).toEqual([
      ['file:///alpha', 'toggle.scm0'],
      ['file:///beta', 'toggle.scm1'],
      ['file:///gamma', 'toggle.scm2'],
    ]);
    // The last repository is identified by elimination, never left hidden.
    expect([...world.visible]).toEqual(['gamma']);
    expect([...hidden]).toEqual(['toggle.scm0', 'toggle.scm1']);
    expect(executed.some(command => command.includes('setSelectionMode'))).toBe(false);
  });

  it('reports repositories that were already hidden instead of guessing', async () => {
    const world = nativeWorld(['alpha', 'beta', 'gamma'], ['gamma']);
    const { ledger } = ledgerOver(world.execute);

    await expect(probeVisibilityMappings(
      world.repositories,
      world.commands,
      ledger,
      fastTimings,
    )).rejects.toBeInstanceOf(RepositoriesAlreadyHiddenError);
  });

  it('leaves the pre-existing hidden repository hidden when it declines', async () => {
    const world = nativeWorld(['alpha', 'beta', 'gamma'], ['gamma']);
    const { ledger, hidden } = ledgerOver(world.execute);

    await probeVisibilityMappings(world.repositories, world.commands, ledger, fastTimings)
      .catch(() => undefined);

    expect(world.visible.has('gamma')).toBe(false);
    // Everything the probe itself hid is still owned, so recovery can undo it.
    expect([...hidden]).toEqual(['toggle.scm0']);
  });

  it('retains ownership of a hide whose native command rejected', async () => {
    const world = nativeWorld(['alpha', 'beta']);
    const failure = new Error('native command failed');
    const { ledger, hidden } = ledgerOver(command => command === 'toggle.scm0'
      ? Promise.reject(failure)
      : world.execute(command));

    await expect(probeVisibilityMappings(
      world.repositories,
      world.commands,
      ledger,
      fastTimings,
    )).rejects.toThrow(failure);
    expect([...hidden]).toEqual(['toggle.scm0']);
  });

  it('rejects when the command set cannot cover every repository exactly once', async () => {
    const world = nativeWorld(['alpha', 'beta', 'gamma']);
    const { ledger } = ledgerOver(world.execute);

    await expect(probeVisibilityMappings(
      world.repositories,
      world.commands.slice(0, 2),
      ledger,
      fastTimings,
    )).rejects.toThrow('exactly one native visibility command');
  });

  it('rejects when native focus never settles', async () => {
    const repositories = [
      repository('alpha', () => true),
      repository('beta', () => true),
    ];
    const { ledger } = ledgerOver(() => Promise.resolve());

    await expect(probeVisibilityMappings(
      repositories,
      ['toggle.scm0', 'toggle.scm1'],
      ledger,
      fastTimings,
    )).rejects.toThrow('Native repository focus did not settle.');
  });
});
