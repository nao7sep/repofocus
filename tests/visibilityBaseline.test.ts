import { describe, expect, it, vi } from 'vitest';
import type { GitRepository } from '../src/gitApi';
import {
  mapVisibilityCommandsInOrder,
  VisibilityProbeError,
  VisibilityProbeInterruptedError,
  VisibilityProbeLimitError,
  type VisibilityProbeLedger,
} from '../src/visibilityBaseline';

function repository(name: string, selected: () => boolean): GitRepository {
  return {
    rootUri: { fsPath: `/${name}`, toString: () => `file:///${name}` },
    ui: { get selected() { return selected(); }, onDidChange: () => ({ dispose() {} }) },
  } as unknown as GitRepository;
}

function nativeWorld(
  names: readonly string[],
  commandOrder = names,
  selectedAtStart = commandOrder[0],
) {
  const visible = new Set(names);
  let selectedName: string | undefined = selectedAtStart;
  const targets = new Map(commandOrder.map((name, index) => [`toggle.scm${index}`, name]));
  const repositories = names.map(name => repository(name, () => selectedName === name));
  const executed: string[] = [];
  const ledger: VisibilityProbeLedger = {
    hide: async command => {
      executed.push(`hide:${command}`);
      const target = targets.get(command);
      if (!target) throw new Error(`Unknown command: ${command}`);
      visible.delete(target);
      if (selectedName === target) {
        selectedName = commandOrder.find(name => visible.has(name));
      }
    },
    reveal: async command => {
      executed.push(`reveal:${command}`);
      const target = targets.get(command);
      if (!target) throw new Error(`Unknown command: ${command}`);
      visible.add(target);
    },
  };
  return {
    commands: [...targets.keys()],
    executed,
    ledger,
    repositories,
    selected: () => selectedName,
    visible,
  };
}

const fastTimings = {
  selectionTimeoutMilliseconds: 20,
  totalTimeoutMilliseconds: 1_000,
} as const;

describe('mapVisibilityCommandsInOrder', () => {
  it.each([2, 3, 50])('maps %i repositories with exactly 3N - 3 bounded toggles', async count => {
    const names = Array.from({ length: count }, (_, index) => `repo-${index}`);
    const world = nativeWorld(names);

    const mappings = await mapVisibilityCommandsInOrder(
      world.repositories,
      world.commands,
      world.ledger,
      fastTimings,
    );

    expect(mappings.map(mapping => mapping.command)).toEqual(world.commands);
    expect(world.executed).toHaveLength(3 * count - 3);
    expect(world.visible.size).toBe(1);
  });

  it('maps repositories in native selection order rather than Git API array order', async () => {
    const names = ['alpha', 'beta', 'gamma', 'delta'];
    const commandOrder = ['gamma', 'alpha', 'delta', 'beta'];
    const world = nativeWorld(names, commandOrder);

    const mappings = await mapVisibilityCommandsInOrder(
      world.repositories,
      world.commands,
      world.ledger,
      fastTimings,
    );

    expect(mappings.map(mapping => mapping.repository.rootUri.toString())).toEqual(
      commandOrder.map(name => `file:///${name}`),
    );
    expect(world.executed[0]).toBe('hide:toggle.scm0');
    expect(world.selected()).toBe('gamma');
  });

  it('fails without searching when native focus does not follow an isolated visibility change', async () => {
    const world = nativeWorld(['alpha', 'beta', 'gamma']);
    let hideCount = 0;
    const ledger: VisibilityProbeLedger = {
      hide: async command => {
        hideCount += 1;
        if (hideCount === 3) return;
        await world.ledger.hide(command);
      },
      reveal: command => world.ledger.reveal(command),
    };

    await expect(mapVisibilityCommandsInOrder(
      world.repositories,
      world.commands,
      ledger,
      fastTimings,
    )).rejects.toBeInstanceOf(VisibilityProbeError);

    expect(hideCount).toBe(3);
    expect(world.executed).toEqual([
      'hide:toggle.scm0',
      'hide:toggle.scm1',
      'reveal:toggle.scm1',
      'reveal:toggle.scm2',
    ]);
  });

  it('rejects command sets that do not cover repositories exactly once', async () => {
    const world = nativeWorld(['alpha', 'beta']);

    await expect(mapVisibilityCommandsInOrder(
      world.repositories,
      world.commands.slice(0, 1),
      world.ledger,
      fastTimings,
    )).rejects.toThrow('exactly one native visibility command');
    expect(world.executed).toEqual([]);
  });

  it('rejects missing or ambiguous native selection', async () => {
    const none = [repository('alpha', () => false), repository('beta', () => false)];
    const both = [repository('alpha', () => true), repository('beta', () => true)];
    const ledger: VisibilityProbeLedger = {
      hide: vi.fn(() => Promise.resolve()),
      reveal: vi.fn(() => Promise.resolve()),
    };

    await expect(mapVisibilityCommandsInOrder(
      none,
      ['toggle.scm0', 'toggle.scm1'],
      ledger,
      fastTimings,
    )).rejects.toThrow('focus did not settle');
    await expect(mapVisibilityCommandsInOrder(
      both,
      ['toggle.scm0', 'toggle.scm1'],
      ledger,
      fastTimings,
    )).rejects.toThrow('focus did not settle');
    expect(ledger.hide).toHaveBeenCalledTimes(2);
  });

  it('interrupts immediately after a stale hide so recovery retains ownership', async () => {
    const world = nativeWorld(['alpha', 'beta']);
    let current = true;
    const ledger: VisibilityProbeLedger = {
      hide: async command => {
        await world.ledger.hide(command);
        current = false;
      },
      reveal: command => world.ledger.reveal(command),
    };

    await expect(mapVisibilityCommandsInOrder(
      world.repositories,
      world.commands,
      ledger,
      { ...fastTimings, isCurrent: () => current },
    )).rejects.toBeInstanceOf(VisibilityProbeInterruptedError);
    expect(world.executed).toEqual(['hide:toggle.scm0']);
  });

  it('bounds the total time spent waiting for native focus', async () => {
    vi.useFakeTimers();
    try {
      const repositories = [repository('alpha', () => false), repository('beta', () => false)];
      const ledger: VisibilityProbeLedger = {
        hide: vi.fn(() => Promise.resolve()),
        reveal: vi.fn(() => Promise.resolve()),
      };
      const mapping = mapVisibilityCommandsInOrder(
        repositories,
        ['toggle.scm0', 'toggle.scm1'],
        ledger,
        { selectionTimeoutMilliseconds: 1_000, totalTimeoutMilliseconds: 20 },
      );
      const result = expect(mapping).rejects.toBeInstanceOf(VisibilityProbeLimitError);

      await vi.advanceTimersByTimeAsync(30);
      await result;
    } finally {
      vi.useRealTimers();
    }
  });
});
