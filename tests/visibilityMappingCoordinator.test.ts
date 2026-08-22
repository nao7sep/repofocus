import { describe, expect, it, vi } from 'vitest';
import type { RepositoryActionability } from '../src/actionability';
import type { GitRepository } from '../src/gitApi';
import { selectionModeCommands, visibilityCommandPrefix } from '../src/visibilityCommandResolver';
import { VisibilityMappingCoordinator } from '../src/visibilityMappingCoordinator';
import { VisibilityReconciler } from '../src/visibilityReconciler';

const clean: RepositoryActionability = { actionable: false, reasons: [] };

interface NativeRepositoryFixture {
  readonly commands: readonly string[];
  readonly discoveryCommands: readonly string[];
  readonly execute: (command: string) => Promise<void>;
  readonly repositories: readonly GitRepository[];
  readonly reset: () => Promise<void>;
  readonly visible: Set<string>;
}

function nativeRepositories(
  names: readonly string[],
  commandOrder: readonly string[] = names,
  selectedAfterReset = commandOrder[0],
  staleFocusOnToggle?: number,
): NativeRepositoryFixture {
  const visible = new Set(names);
  let selected: string | undefined = commandOrder[0];
  const repositories = names.map(name => ({
    rootUri: { fsPath: `/${name}`, toString: () => `file:///${name}` },
    ui: {
      get selected() { return selected === name; },
      onDidChange: () => ({ dispose() {} }),
    },
  })) as unknown as readonly GitRepository[];
  const commands = commandOrder.map((_, index) => `${visibilityCommandPrefix}scm${index}`);
  const targets = new Map(commands.map((command, index) => [command, commandOrder[index]]));
  let toggleCount = 0;
  return {
    commands,
    discoveryCommands: [selectionModeCommands.single, selectionModeCommands.multiple, ...commands],
    repositories,
    visible,
    reset: async () => {
      for (const name of names) visible.add(name);
      selected = selectedAfterReset;
    },
    execute: async command => {
      toggleCount += 1;
      const target = targets.get(command);
      if (!target) throw new Error(`Unexpected command: ${command}`);
      if (visible.delete(target)) {
        if (selected === target && toggleCount !== staleFocusOnToggle) {
          selected = commandOrder.find(name => visible.has(name));
        }
      } else {
        visible.add(target);
      }
    },
  };
}

function coordinatorFixture(names: readonly string[]) {
  const native = nativeRepositories(names);
  const execute = vi.fn(native.execute);
  const resetNativeVisibility = vi.fn(native.reset);
  const getCommands = vi.fn(() => Promise.resolve(native.discoveryCommands));
  const reconciler = new VisibilityReconciler({ toggle: execute });
  for (const repository of native.repositories) reconciler.setActionability(repository, clean);
  const coordinator = new VisibilityMappingCoordinator({
    filteringRequested: () => true,
    getCommands,
    getRepositories: () => native.repositories,
    topologyReady: () => true,
    resetNativeVisibility,
    reconciler,
    probeTimings: {
      selectionTimeoutMilliseconds: 20,
      totalTimeoutMilliseconds: 1_000,
    },
    commandRetryMilliseconds: 0,
    topologySettleMilliseconds: 0,
  });
  return { coordinator, execute, getCommands, native, reconciler, resetNativeVisibility };
}

describe('VisibilityMappingCoordinator', () => {
  it('keeps a single repository visible without reading or mutating native visibility', async () => {
    const fixture = coordinatorFixture(['alpha']);

    fixture.coordinator.requestRefresh();
    await fixture.coordinator.waitForIdle();

    expect(fixture.getCommands).not.toHaveBeenCalled();
    expect(fixture.resetNativeVisibility).not.toHaveBeenCalled();
    expect(fixture.execute).not.toHaveBeenCalled();
    expect(fixture.reconciler.enabled).toBe(false);
  });

  it.each([2, 50])('maps and filters %i clean repositories with linear native work', async count => {
    const fixture = coordinatorFixture(
      Array.from({ length: count }, (_, index) => `repo-${index}`),
    );

    fixture.coordinator.requestRefresh();
    await fixture.coordinator.waitForIdle();
    await fixture.reconciler.waitForIdle();

    expect(fixture.coordinator.baselineEstablished).toBe(true);
    expect(fixture.resetNativeVisibility).toHaveBeenCalledOnce();
    // 3N - 3 mapping toggles plus one reconciliation hide for the last visible repository.
    expect(fixture.execute).toHaveBeenCalledTimes(3 * count - 2);
    expect(fixture.reconciler.hiddenRepositoryCount).toBe(count);
    expect(fixture.native.visible.size).toBe(0);
  });

  it('waits for the initial Git scan before reading commands or changing visibility', async () => {
    const native = nativeRepositories(['alpha', 'beta']);
    let ready = false;
    const onUnavailable = vi.fn();
    const execute = vi.fn(native.execute);
    const getCommands = vi.fn(() => Promise.resolve(native.discoveryCommands));
    const resetNativeVisibility = vi.fn(native.reset);
    const reconciler = new VisibilityReconciler({ toggle: execute });
    for (const repository of native.repositories) reconciler.setActionability(repository, clean);
    const coordinator = new VisibilityMappingCoordinator({
      filteringRequested: () => true,
      getCommands,
      getRepositories: () => native.repositories,
      topologyReady: () => ready,
      resetNativeVisibility,
      reconciler,
      onUnavailable,
      topologySettleMilliseconds: 0,
    });

    coordinator.requestRefresh();
    await coordinator.waitForIdle();
    expect(coordinator.mappingState).toBe('loading-repositories');
    expect(onUnavailable).toHaveBeenCalledWith('loading-repositories');
    expect(getCommands).not.toHaveBeenCalled();
    expect(resetNativeVisibility).not.toHaveBeenCalled();

    ready = true;
    coordinator.requestRefresh();
    await coordinator.waitForIdle();
    expect(coordinator.baselineEstablished).toBe(true);
  });

  it('bounds lazy command-registration retries and requires an event or manual refresh afterward', async () => {
    const native = nativeRepositories(['alpha', 'beta']);
    let commandsReady = false;
    const getCommands = vi.fn(() => Promise.resolve(commandsReady
      ? native.discoveryCommands
      : [selectionModeCommands.single, selectionModeCommands.multiple]));
    const reconciler = new VisibilityReconciler({ toggle: native.execute });
    for (const repository of native.repositories) reconciler.setActionability(repository, clean);
    const coordinator = new VisibilityMappingCoordinator({
      filteringRequested: () => true,
      getCommands,
      getRepositories: () => native.repositories,
      topologyReady: () => true,
      resetNativeVisibility: native.reset,
      reconciler,
      commandRetryAttempts: 3,
      commandRetryMilliseconds: 0,
      topologySettleMilliseconds: 0,
    });

    coordinator.requestRefresh();
    await coordinator.waitForIdle();
    expect(getCommands).toHaveBeenCalledTimes(3);
    expect(coordinator.mappingState).toBe('awaiting-native-commands');

    await Promise.resolve();
    await Promise.resolve();
    expect(getCommands).toHaveBeenCalledTimes(3);

    commandsReady = true;
    coordinator.retryIfUnavailable();
    await coordinator.waitForIdle();
    expect(coordinator.baselineEstablished).toBe(true);
    expect(getCommands).toHaveBeenCalledTimes(4);

    coordinator.retryIfUnavailable();
    await coordinator.waitForIdle();
    expect(getCommands).toHaveBeenCalledTimes(4);
  });

  it('enforces one overall command-enumeration deadline without overlapping a stalled host call', async () => {
    const native = nativeRepositories(['alpha', 'beta']);
    const gate = new Promise<readonly string[]>(() => {});
    const getCommands = vi.fn(() => gate);
    const onError = vi.fn();
    const reconciler = new VisibilityReconciler({ toggle: native.execute, onError });
    const coordinator = new VisibilityMappingCoordinator({
      filteringRequested: () => true,
      getCommands,
      getRepositories: () => native.repositories,
      topologyReady: () => true,
      resetNativeVisibility: native.reset,
      reconciler,
      commandRetryTimeoutMilliseconds: 10,
      topologySettleMilliseconds: 0,
    });

    coordinator.requestRefresh();
    await coordinator.waitForIdle();

    expect(getCommands).toHaveBeenCalledOnce();
    expect(reconciler.compatible).toBe(false);
    expect((onError.mock.calls[0][0] as Error).message).toContain('command enumeration');
  });

  it('discards command enumeration that settles after its topology revision becomes stale', async () => {
    const native = nativeRepositories(['alpha', 'beta']);
    let resolveFirst!: (commands: readonly string[]) => void;
    let markStarted!: () => void;
    const first = new Promise<readonly string[]>(resolve => { resolveFirst = resolve; });
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const getCommands = vi.fn(() => {
      if (getCommands.mock.calls.length === 1) {
        markStarted();
        return first;
      }
      return Promise.resolve(native.discoveryCommands);
    });
    const resetNativeVisibility = vi.fn(native.reset);
    const reconciler = new VisibilityReconciler({ toggle: native.execute });
    for (const repository of native.repositories) reconciler.setActionability(repository, clean);
    const coordinator = new VisibilityMappingCoordinator({
      filteringRequested: () => true,
      getCommands,
      getRepositories: () => native.repositories,
      topologyReady: () => true,
      resetNativeVisibility,
      reconciler,
      topologySettleMilliseconds: 0,
    });

    coordinator.requestRefresh();
    await started;
    coordinator.requestRefresh();
    resolveFirst(native.discoveryCommands);
    await coordinator.waitForIdle();

    expect(getCommands).toHaveBeenCalledTimes(2);
    expect(resetNativeVisibility).toHaveBeenCalledOnce();
    expect(coordinator.baselineEstablished).toBe(true);
  });

  it('coalesces refreshes requested before a mapping transaction begins', async () => {
    const fixture = coordinatorFixture(['alpha', 'beta']);
    const initialized = vi.fn();
    const coordinator = new VisibilityMappingCoordinator({
      filteringRequested: () => true,
      getCommands: fixture.getCommands,
      getRepositories: () => fixture.native.repositories,
      topologyReady: () => true,
      resetNativeVisibility: fixture.resetNativeVisibility,
      reconciler: fixture.reconciler,
      onInitialized: initialized,
      topologySettleMilliseconds: 0,
    });

    coordinator.requestRefresh();
    coordinator.requestRefresh();
    coordinator.requestRefresh();
    await coordinator.waitForIdle();

    expect(initialized).toHaveBeenCalledOnce();
    expect(fixture.resetNativeVisibility).toHaveBeenCalledOnce();
  });

  it('restores visibility while filtering is off and reuses the verified mapping when re-enabled', async () => {
    const native = nativeRepositories(['alpha', 'beta']);
    let filteringRequested = true;
    const execute = vi.fn(native.execute);
    const getCommands = vi.fn(() => Promise.resolve(native.discoveryCommands));
    const resetNativeVisibility = vi.fn(native.reset);
    const reconciler = new VisibilityReconciler({ toggle: execute });
    for (const repository of native.repositories) reconciler.setActionability(repository, clean);
    const coordinator = new VisibilityMappingCoordinator({
      filteringRequested: () => filteringRequested,
      getCommands,
      getRepositories: () => native.repositories,
      topologyReady: () => true,
      resetNativeVisibility,
      reconciler,
      topologySettleMilliseconds: 0,
    });
    coordinator.requestRefresh();
    await coordinator.waitForIdle();

    filteringRequested = false;
    await coordinator.updateFiltering(false);
    expect(native.visible.size).toBe(2);

    filteringRequested = true;
    await coordinator.updateFiltering(true);
    expect(native.visible.size).toBe(0);
    expect(getCommands).toHaveBeenCalledOnce();
    expect(resetNativeVisibility).toHaveBeenCalledOnce();
  });

  it('stands down recoverably when another SCM provider is present', async () => {
    const native = nativeRepositories(['alpha', 'beta']);
    const onError = vi.fn();
    const onUnavailable = vi.fn();
    const execute = vi.fn(native.execute);
    const resetNativeVisibility = vi.fn(native.reset);
    const reconciler = new VisibilityReconciler({ toggle: execute, onError });
    const coordinator = new VisibilityMappingCoordinator({
      filteringRequested: () => true,
      getCommands: () => Promise.resolve([
        ...native.discoveryCommands,
        `${visibilityCommandPrefix}scm9`,
      ]),
      getRepositories: () => native.repositories,
      topologyReady: () => true,
      resetNativeVisibility,
      reconciler,
      onUnavailable,
      commandRetryAttempts: 1,
      topologySettleMilliseconds: 0,
    });

    coordinator.requestRefresh();
    await coordinator.waitForIdle();

    expect(coordinator.mappingState).toBe('other-scm-providers');
    expect(onUnavailable).toHaveBeenCalledWith('other-scm-providers');
    expect(reconciler.compatible).toBe(true);
    expect(resetNativeVisibility).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('abandons a stale transaction and completes only the newest topology revision', async () => {
    const fixture = coordinatorFixture(['alpha', 'beta']);
    const initialized = vi.fn();
    let interrupted = false;
    let coordinator!: VisibilityMappingCoordinator;
    const resetNativeVisibility = vi.fn(async () => {
      await fixture.native.reset();
      if (!interrupted) {
        interrupted = true;
        coordinator.requestRefresh();
      }
    });
    coordinator = new VisibilityMappingCoordinator({
      filteringRequested: () => true,
      getCommands: fixture.getCommands,
      getRepositories: () => fixture.native.repositories,
      topologyReady: () => true,
      resetNativeVisibility,
      reconciler: fixture.reconciler,
      onInitialized: initialized,
      topologySettleMilliseconds: 0,
    });

    coordinator.requestRefresh();
    await coordinator.waitForIdle();

    expect(resetNativeVisibility).toHaveBeenCalledTimes(2);
    expect(initialized).toHaveBeenCalledOnce();
    expect(coordinator.baselineEstablished).toBe(true);
  });

  it('fails compatibility without hiding anything when the native reset fails', async () => {
    const native = nativeRepositories(['alpha', 'beta']);
    const failure = new Error('native reset failed');
    const onError = vi.fn();
    const execute = vi.fn(native.execute);
    const reconciler = new VisibilityReconciler({ toggle: execute, onError });
    const coordinator = new VisibilityMappingCoordinator({
      filteringRequested: () => true,
      getCommands: () => Promise.resolve(native.discoveryCommands),
      getRepositories: () => native.repositories,
      topologyReady: () => true,
      resetNativeVisibility: () => Promise.reject(failure),
      reconciler,
      commandRetryAttempts: 1,
      topologySettleMilliseconds: 0,
    });

    coordinator.requestRefresh();
    await coordinator.waitForIdle();

    expect(reconciler.compatible).toBe(false);
    expect(reconciler.hiddenRepositoryCount).toBe(0);
    expect(execute).not.toHaveBeenCalled();
    expect(onError.mock.calls[0][0]).toBe(failure);
  });

  it('fails visible when native focus stops following isolated visibility changes', async () => {
    const native = nativeRepositories(
      ['alpha', 'beta', 'gamma'],
      ['alpha', 'beta', 'gamma'],
      'alpha',
      2,
    );
    const onError = vi.fn();
    const execute = vi.fn(native.execute);
    const reconciler = new VisibilityReconciler({ toggle: execute, onError });
    const coordinator = new VisibilityMappingCoordinator({
      filteringRequested: () => true,
      getCommands: () => Promise.resolve(native.discoveryCommands),
      getRepositories: () => native.repositories,
      topologyReady: () => true,
      resetNativeVisibility: native.reset,
      reconciler,
      commandRetryAttempts: 1,
      probeTimings: { selectionTimeoutMilliseconds: 20 },
      topologySettleMilliseconds: 0,
    });

    coordinator.requestRefresh();
    await coordinator.waitForIdle();

    expect(reconciler.compatible).toBe(false);
    expect(native.visible.size).toBe(3);
    expect(execute).toHaveBeenCalledTimes(6);
    expect(onError).toHaveBeenCalledOnce();
  });

  it('fails compatibility when the native selection-mode command family disappears', async () => {
    const native = nativeRepositories(['alpha', 'beta']);
    const onError = vi.fn();
    const reconciler = new VisibilityReconciler({ toggle: native.execute, onError });
    const coordinator = new VisibilityMappingCoordinator({
      filteringRequested: () => true,
      getCommands: () => Promise.resolve(native.commands),
      getRepositories: () => native.repositories,
      topologyReady: () => true,
      resetNativeVisibility: native.reset,
      reconciler,
      commandRetryAttempts: 1,
      topologySettleMilliseconds: 0,
    });

    coordinator.requestRefresh();
    await coordinator.waitForIdle();

    expect(reconciler.compatible).toBe(false);
    expect((onError.mock.calls[0][0] as Error).message).toContain('selection-mode commands');
  });

  it('surfaces command-registry failures instead of treating them as lazy registration', async () => {
    const native = nativeRepositories(['alpha', 'beta']);
    const failure = new Error('command registry unavailable');
    const onError = vi.fn();
    const reconciler = new VisibilityReconciler({ toggle: native.execute, onError });
    const coordinator = new VisibilityMappingCoordinator({
      filteringRequested: () => true,
      getCommands: () => Promise.reject(failure),
      getRepositories: () => native.repositories,
      topologyReady: () => true,
      resetNativeVisibility: native.reset,
      reconciler,
      commandRetryAttempts: 1,
      topologySettleMilliseconds: 0,
    });

    coordinator.requestRefresh();
    await coordinator.waitForIdle();

    expect(reconciler.compatible).toBe(false);
    expect(onError.mock.calls[0][0]).toBe(failure);
  });
});
