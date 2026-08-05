import { describe, expect, it, vi } from 'vitest';
import type { RepositoryActionability } from '../src/actionability';
import type { GitRepository } from '../src/gitApi';
import { visibilityCommandPrefix } from '../src/visibilityCommandResolver';
import { VisibilityMappingCoordinator } from '../src/visibilityMappingCoordinator';
import { VisibilityReconciler } from '../src/visibilityReconciler';

const clean: RepositoryActionability = { actionable: false, reasons: [] };

interface NativeRepositoryFixture {
  readonly commands: readonly string[];
  readonly execute: (command: string) => Promise<void>;
  readonly repositories: readonly GitRepository[];
}

function nativeRepositories(names: readonly string[]): NativeRepositoryFixture {
  const visible = new Set(names);
  let selected = names[0];
  const repositories = names.map(name => ({
    rootUri: { fsPath: `/${name}`, toString: () => `file:///${name}` },
    ui: {
      get selected() { return selected === name; },
      onDidChange: () => ({ dispose() {} }),
    },
  })) as unknown as readonly GitRepository[];
  const commands = names.map((_, index) => `${visibilityCommandPrefix}scm${index}`);
  const targets = new Map(commands.map((command, index) => [command, names[index]]));
  return {
    commands,
    repositories,
    execute: command => {
      if (command.endsWith('.single')) {
        const first = names.find(name => visible.has(name)) ?? names[0];
        visible.clear();
        if (first) {
          visible.add(first);
          selected = first;
        }
        return Promise.resolve();
      }
      if (command.endsWith('.multiple')) {
        for (const name of names) visible.add(name);
        return Promise.resolve();
      }
      const target = targets.get(command);
      if (!target) throw new Error(`Unexpected command: ${command}`);
      if (visible.delete(target)) {
        if (selected === target) selected = names.find(name => visible.has(name)) ?? target;
      } else {
        visible.add(target);
      }
      return Promise.resolve();
    },
  };
}

function coordinatorFixture(
  names: readonly string[],
  minimumRepositoryCount = 2,
): {
  readonly coordinator: VisibilityMappingCoordinator;
  readonly execute: ReturnType<typeof vi.fn>;
  readonly getCommands: ReturnType<typeof vi.fn>;
  readonly reconciler: VisibilityReconciler;
} {
  const native = nativeRepositories(names);
  const execute = vi.fn(native.execute);
  const getCommands = vi.fn(() => Promise.resolve(native.commands));
  const reconciler = new VisibilityReconciler({ toggle: execute });
  for (const repository of native.repositories) reconciler.setActionability(repository, clean);
  const coordinator = new VisibilityMappingCoordinator({
    execute,
    filteringRequested: () => true,
    getCommands,
    getNativeVisibleLimit: () => 100,
    getRepositories: () => native.repositories,
    minimumRepositoryCount: () => minimumRepositoryCount,
    reconciler,
    baselineTimings: {
      modeSettleMilliseconds: 0,
      probeMilliseconds: 1,
      selectionTimeoutMilliseconds: 1,
    },
    commandRetryMilliseconds: 0,
    topologySettleMilliseconds: 0,
  });
  return { coordinator, execute, getCommands, reconciler };
}

describe('VisibilityMappingCoordinator', () => {
  it('keeps a single repository visible without invoking native visibility commands by default', async () => {
    const fixture = coordinatorFixture(['alpha']);

    fixture.coordinator.requestRefresh();
    await fixture.coordinator.waitForIdle();

    expect(fixture.getCommands).not.toHaveBeenCalled();
    expect(fixture.execute).not.toHaveBeenCalled();
    expect(fixture.reconciler.enabled).toBe(false);
    expect(fixture.reconciler.hiddenRepositoryCount).toBe(0);
  });

  it('maps and filters multiple repositories without opening or focusing a workbench pane', async () => {
    const fixture = coordinatorFixture(['alpha', 'beta']);

    fixture.coordinator.requestRefresh();
    await fixture.coordinator.waitForIdle();

    expect(fixture.coordinator.baselineEstablished).toBe(true);
    expect(fixture.reconciler.hiddenRepositoryCount).toBe(2);
    expect(fixture.execute.mock.calls.flat()).not.toContain('workbench.view.scm');
    expect(fixture.execute.mock.calls.flat()).not.toContain('workbench.scm.focus');
  });

  it('waits passively for VS Code to register visibility commands', async () => {
    const native = nativeRepositories(['alpha', 'beta']);
    let commandReadCount = 0;
    const execute = vi.fn(native.execute);
    const reconciler = new VisibilityReconciler({ toggle: execute });
    for (const repository of native.repositories) reconciler.setActionability(repository, clean);
    const coordinator = new VisibilityMappingCoordinator({
      execute,
      filteringRequested: () => true,
      getCommands: () => {
        commandReadCount += 1;
        return Promise.resolve(commandReadCount === 1 ? [] : native.commands);
      },
      getNativeVisibleLimit: () => 100,
      getRepositories: () => native.repositories,
      minimumRepositoryCount: () => 2,
      reconciler,
      baselineTimings: { modeSettleMilliseconds: 0, probeMilliseconds: 1 },
      commandPollMilliseconds: 1,
      commandRetryAttempts: 1,
      topologySettleMilliseconds: 0,
    });

    coordinator.requestRefresh();
    await vi.waitFor(() => expect(coordinator.baselineEstablished).toBe(true));
    await coordinator.waitForIdle();

    expect(commandReadCount).toBe(2);
    expect(reconciler.hiddenRepositoryCount).toBe(2);
    coordinator.dispose();
  });

  it('coalesces requests made before mapping begins', async () => {
    const initialized = vi.fn();
    const native = nativeRepositories(['alpha', 'beta']);
    const execute = vi.fn(native.execute);
    const reconciler = new VisibilityReconciler({ toggle: execute });
    for (const repository of native.repositories) reconciler.setActionability(repository, clean);
    const coordinator = new VisibilityMappingCoordinator({
      execute,
      filteringRequested: () => true,
      getCommands: () => Promise.resolve(native.commands),
      getNativeVisibleLimit: () => 100,
      getRepositories: () => native.repositories,
      minimumRepositoryCount: () => 2,
      onInitialized: initialized,
      reconciler,
      baselineTimings: { modeSettleMilliseconds: 0, probeMilliseconds: 1 },
      topologySettleMilliseconds: 0,
    });

    coordinator.requestRefresh();
    coordinator.requestRefresh();
    coordinator.requestRefresh();
    await coordinator.waitForIdle();

    expect(initialized).toHaveBeenCalledOnce();
  });

  it('reuses a verified baseline when filtering is toggled', async () => {
    const native = nativeRepositories(['alpha', 'beta']);
    let filteringRequested = true;
    let commandReads = 0;
    const execute = vi.fn(native.execute);
    const reconciler = new VisibilityReconciler({ toggle: execute });
    for (const repository of native.repositories) reconciler.setActionability(repository, clean);
    const coordinator = new VisibilityMappingCoordinator({
      execute,
      filteringRequested: () => filteringRequested,
      getCommands: () => {
        commandReads += 1;
        return Promise.resolve(native.commands);
      },
      getNativeVisibleLimit: () => 100,
      getRepositories: () => native.repositories,
      minimumRepositoryCount: () => 2,
      reconciler,
      baselineTimings: { modeSettleMilliseconds: 0, probeMilliseconds: 1 },
      topologySettleMilliseconds: 0,
    });
    coordinator.requestRefresh();
    await coordinator.waitForIdle();

    filteringRequested = false;
    await coordinator.updateFiltering();
    expect(reconciler.hiddenRepositoryCount).toBe(0);

    filteringRequested = true;
    await coordinator.updateFiltering();
    expect(reconciler.hiddenRepositoryCount).toBe(2);
    expect(commandReads).toBe(1);
  });

  it('fails compatibility before native mutation when the visible-repository limit is too low', async () => {
    const native = nativeRepositories(['alpha', 'beta']);
    const onError = vi.fn();
    const execute = vi.fn(native.execute);
    const reconciler = new VisibilityReconciler({ toggle: execute, onError });
    const coordinator = new VisibilityMappingCoordinator({
      execute,
      filteringRequested: () => true,
      getCommands: () => Promise.resolve(native.commands),
      getNativeVisibleLimit: () => 1,
      getRepositories: () => native.repositories,
      minimumRepositoryCount: () => 2,
      reconciler,
      topologySettleMilliseconds: 0,
    });

    coordinator.requestRefresh();
    await coordinator.waitForIdle();

    expect(reconciler.compatible).toBe(false);
    expect(onError).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
  });

  it('fails safely from the recovered all-visible state when mapping cannot identify a command', async () => {
    const native = nativeRepositories(['alpha', 'beta']);
    const onError = vi.fn();
    const execute = vi.fn((command: string) => {
      if (command.endsWith('.single') || command.endsWith('.multiple')) {
        return native.execute(command);
      }
      return Promise.resolve();
    });
    const reconciler = new VisibilityReconciler({ toggle: execute, onError });
    const coordinator = new VisibilityMappingCoordinator({
      execute,
      filteringRequested: () => true,
      getCommands: () => Promise.resolve(native.commands),
      getNativeVisibleLimit: () => 100,
      getRepositories: () => native.repositories,
      minimumRepositoryCount: () => 2,
      reconciler,
      baselineTimings: { modeSettleMilliseconds: 0, probeMilliseconds: 1 },
      topologySettleMilliseconds: 0,
    });

    coordinator.requestRefresh();
    await coordinator.waitForIdle();

    expect(reconciler.compatible).toBe(false);
    expect(reconciler.hiddenRepositoryCount).toBe(0);
    expect(onError).toHaveBeenCalledOnce();
  });

  it('invalidates uncertain ownership when mapping and all-visible recovery both fail', async () => {
    const native = nativeRepositories(['alpha', 'beta']);
    const onError = vi.fn();
    const execute = vi.fn((command: string) => command.endsWith('.single')
      ? Promise.reject(new Error('selection mode unavailable'))
      : native.execute(command));
    const reconciler = new VisibilityReconciler({ toggle: execute, onError });
    const coordinator = new VisibilityMappingCoordinator({
      execute,
      filteringRequested: () => true,
      getCommands: () => Promise.resolve(native.commands),
      getNativeVisibleLimit: () => 100,
      getRepositories: () => native.repositories,
      minimumRepositoryCount: () => 2,
      reconciler,
      baselineTimings: { modeSettleMilliseconds: 0, probeMilliseconds: 1 },
      topologySettleMilliseconds: 0,
    });

    coordinator.requestRefresh();
    await coordinator.waitForIdle();

    expect(reconciler.compatible).toBe(false);
    expect(reconciler.hiddenRepositoryCount).toBe(0);
    expect(onError).toHaveBeenCalledOnce();
  });

  it('surfaces command-enumeration failures instead of treating them as lazy registration', async () => {
    const native = nativeRepositories(['alpha', 'beta']);
    const failure = new Error('command registry unavailable');
    const onError = vi.fn();
    const reconciler = new VisibilityReconciler({ toggle: native.execute, onError });
    const coordinator = new VisibilityMappingCoordinator({
      execute: native.execute,
      filteringRequested: () => true,
      getCommands: () => Promise.reject(failure),
      getNativeVisibleLimit: () => 100,
      getRepositories: () => native.repositories,
      minimumRepositoryCount: () => 2,
      reconciler,
      commandRetryAttempts: 1,
      topologySettleMilliseconds: 0,
    });

    coordinator.requestRefresh();
    await coordinator.waitForIdle();

    expect(reconciler.compatible).toBe(false);
    expect(onError).toHaveBeenCalledWith(failure);
  });

  it('finishes an in-flight mapping transaction before processing a newer topology', async () => {
    const initialized = vi.fn();
    const native = nativeRepositories(['alpha']);
    let requestedDuringTransaction = false;
    const execute = vi.fn(async (command: string) => {
      if (command.endsWith('.single') && !requestedDuringTransaction) {
        requestedDuringTransaction = true;
        coordinator.requestRefresh();
      }
      await native.execute(command);
    });
    const reconciler = new VisibilityReconciler({ toggle: execute });
    reconciler.setActionability(native.repositories[0], clean);
    const coordinator = new VisibilityMappingCoordinator({
      execute,
      filteringRequested: () => true,
      getCommands: () => Promise.resolve(native.commands),
      getNativeVisibleLimit: () => 100,
      getRepositories: () => native.repositories,
      minimumRepositoryCount: () => 1,
      onInitialized: initialized,
      reconciler,
      baselineTimings: { modeSettleMilliseconds: 0, probeMilliseconds: 1 },
      topologySettleMilliseconds: 0,
    });

    coordinator.requestRefresh();
    await coordinator.waitForIdle();

    expect(execute.mock.calls.filter(([command]) => String(command).endsWith('.single'))).toHaveLength(2);
    expect(initialized).toHaveBeenCalledOnce();
    expect(coordinator.baselineEstablished).toBe(true);
    expect(reconciler.hiddenRepositoryCount).toBe(1);
  });
});
