import { describe, expect, it, vi } from 'vitest';
import type { RepositoryActionability } from '../src/actionability';
import type { GitRepository } from '../src/gitApi';
import { selectionModeCommands, visibilityCommandPrefix } from '../src/visibilityCommandResolver';
import { VisibilityMappingCoordinator } from '../src/visibilityMappingCoordinator';
import { VisibilityReconciler } from '../src/visibilityReconciler';

const clean: RepositoryActionability = { actionable: false, reasons: [] };

interface NativeRepositoryFixture {
  readonly commands: readonly string[];
  /** What `getCommands` returns: the per-repository family plus its siblings. */
  readonly discoveryCommands: readonly string[];
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
    discoveryCommands: [
      selectionModeCommands.single,
      selectionModeCommands.multiple,
      ...commands,
    ],
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
  const getCommands = vi.fn(() => Promise.resolve(native.discoveryCommands));
  const reconciler = new VisibilityReconciler({ toggle: execute });
  for (const repository of native.repositories) reconciler.setActionability(repository, clean);
  const coordinator = new VisibilityMappingCoordinator({
    filteringRequested: () => true,
    getCommands,
    getRepositories: () => native.repositories,
    multipleSelectionMode: () => true,
    minimumRepositoryCount: () => minimumRepositoryCount,
    reconciler,
    probeTimings: {
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
      filteringRequested: () => true,
      getCommands: () => {
        commandReadCount += 1;
        // Before Source Control is rendered, only the eagerly-registered
        // selection-mode siblings exist.
        return Promise.resolve(commandReadCount === 1
          ? [selectionModeCommands.single, selectionModeCommands.multiple]
          : native.discoveryCommands);
      },
      getRepositories: () => native.repositories,
      multipleSelectionMode: () => true,
      minimumRepositoryCount: () => 2,
      reconciler,
      probeTimings: { probeMilliseconds: 1 },
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
      filteringRequested: () => true,
      getCommands: () => Promise.resolve(native.discoveryCommands),
      getRepositories: () => native.repositories,
      multipleSelectionMode: () => true,
      minimumRepositoryCount: () => 2,
      onInitialized: initialized,
      reconciler,
      probeTimings: { probeMilliseconds: 1 },
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
      filteringRequested: () => filteringRequested,
      getCommands: () => {
        commandReads += 1;
        return Promise.resolve(native.discoveryCommands);
      },
      getRepositories: () => native.repositories,
      multipleSelectionMode: () => true,
      minimumRepositoryCount: () => 2,
      reconciler,
      probeTimings: { probeMilliseconds: 1 },
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

  it('never consults or writes VS Code configuration while mapping', async () => {
    const fixture = coordinatorFixture(['alpha', 'beta']);

    fixture.coordinator.requestRefresh();
    await fixture.coordinator.waitForIdle();

    expect(fixture.coordinator.baselineEstablished).toBe(true);
    expect(fixture.execute.mock.calls.flat().some(command =>
      String(command).includes('setSelectionMode'))).toBe(false);
  });

  it('declines without failing compatibility when repositories are already hidden', async () => {
    const native = nativeRepositories(['alpha', 'beta']);
    const onError = vi.fn();
    const onUnavailable = vi.fn();
    // Nothing moves focus, so the probe cannot identify anything: the shape a
    // pre-hidden repository set produces.
    const execute = vi.fn(() => Promise.resolve());
    const reconciler = new VisibilityReconciler({ toggle: execute, onError });
    const coordinator = new VisibilityMappingCoordinator({
      filteringRequested: () => true,
      getCommands: () => Promise.resolve(native.discoveryCommands),
      getRepositories: () => native.repositories,
      multipleSelectionMode: () => true,
      minimumRepositoryCount: () => 2,
      reconciler,
      onUnavailable,
      probeTimings: { probeMilliseconds: 1, selectionTimeoutMilliseconds: 1 },
      topologySettleMilliseconds: 0,
    });

    coordinator.requestRefresh();
    await coordinator.waitForIdle();

    expect(onUnavailable).toHaveBeenCalledWith('repositories-already-hidden');
    expect(coordinator.mappingState).toBe('repositories-already-hidden');
    // Declining is not a compatibility failure: recovery is still possible.
    expect(reconciler.compatible).toBe(true);
    expect(reconciler.enabled).toBe(false);
    expect(reconciler.hiddenRepositoryCount).toBe(0);
    expect(onError).not.toHaveBeenCalled();
  });

  it('restores everything the probe hid when a native command fails part-way', async () => {
    const native = nativeRepositories(['alpha', 'beta', 'gamma']);
    const onError = vi.fn();
    let toggles = 0;
    const execute = vi.fn((command: string) => {
      toggles += 1;
      // Fail after the probe has already hidden one repository.
      return toggles === 3 ? Promise.reject(new Error('native command failed')) : native.execute(command);
    });
    const reconciler = new VisibilityReconciler({ toggle: execute, onError });
    const coordinator = new VisibilityMappingCoordinator({
      filteringRequested: () => true,
      getCommands: () => Promise.resolve(native.discoveryCommands),
      getRepositories: () => native.repositories,
      multipleSelectionMode: () => true,
      minimumRepositoryCount: () => 2,
      reconciler,
      probeTimings: { probeMilliseconds: 1, selectionTimeoutMilliseconds: 1 },
      topologySettleMilliseconds: 0,
    });

    coordinator.requestRefresh();
    await coordinator.waitForIdle();

    expect(reconciler.compatible).toBe(false);
    // The ledger knew exactly what had been hidden, so nothing is stranded.
    expect(reconciler.hiddenRepositoryCount).toBe(0);
    expect(onError).toHaveBeenCalled();
  });

  it('declines while the repository selection mode is single, and recovers when it changes', async () => {
    const native = nativeRepositories(['alpha', 'beta']);
    const onUnavailable = vi.fn();
    const execute = vi.fn(native.execute);
    const reconciler = new VisibilityReconciler({ toggle: execute });
    for (const repository of native.repositories) reconciler.setActionability(repository, clean);
    let multiple = false;
    const coordinator = new VisibilityMappingCoordinator({
      filteringRequested: () => true,
      getCommands: () => Promise.resolve(native.discoveryCommands),
      getRepositories: () => native.repositories,
      multipleSelectionMode: () => multiple,
      minimumRepositoryCount: () => 2,
      reconciler,
      onUnavailable,
      probeTimings: { probeMilliseconds: 1, selectionTimeoutMilliseconds: 1 },
      topologySettleMilliseconds: 0,
    });

    coordinator.requestRefresh();
    await coordinator.waitForIdle();

    expect(onUnavailable).toHaveBeenCalledWith('single-selection-mode');
    expect(execute).not.toHaveBeenCalled();
    expect(reconciler.compatible).toBe(true);

    multiple = true;
    coordinator.requestRefresh();
    await coordinator.waitForIdle();

    expect(coordinator.baselineEstablished).toBe(true);
    expect(reconciler.hiddenRepositoryCount).toBe(2);
  });

  it('declines instead of failing when another SCM provider is present', async () => {
    const native = nativeRepositories(['alpha', 'beta']);
    const onError = vi.fn();
    const onUnavailable = vi.fn();
    const execute = vi.fn(native.execute);
    const reconciler = new VisibilityReconciler({ toggle: execute, onError });
    for (const repository of native.repositories) reconciler.setActionability(repository, clean);
    let extraProvider = true;
    const coordinator = new VisibilityMappingCoordinator({
      filteringRequested: () => true,
      getCommands: () => Promise.resolve(extraProvider
        ? [...native.discoveryCommands, `${visibilityCommandPrefix}scm9`]
        : native.discoveryCommands),
      getRepositories: () => native.repositories,
      multipleSelectionMode: () => true,
      minimumRepositoryCount: () => 2,
      reconciler,
      onUnavailable,
      commandRetryAttempts: 1,
      probeTimings: { probeMilliseconds: 1, selectionTimeoutMilliseconds: 1 },
      topologySettleMilliseconds: 0,
    });

    coordinator.requestRefresh();
    await coordinator.waitForIdle();

    expect(onUnavailable).toHaveBeenCalledWith('other-scm-providers');
    expect(coordinator.mappingState).toBe('other-scm-providers');
    // An unsupported workspace is not a broken VS Code: it must stay recoverable.
    expect(reconciler.compatible).toBe(true);
    expect(onError).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();

    extraProvider = false;
    coordinator.requestRefresh();
    await coordinator.waitForIdle();

    expect(coordinator.baselineEstablished).toBe(true);
    expect(reconciler.hiddenRepositoryCount).toBe(2);
  });

  it('retries an unavailable state on manual refresh and leaves a mapped one alone', async () => {
    const native = nativeRepositories(['alpha', 'beta']);
    const execute = vi.fn(native.execute);
    const reconciler = new VisibilityReconciler({ toggle: execute });
    for (const repository of native.repositories) reconciler.setActionability(repository, clean);
    let extraProvider = true;
    let commandReads = 0;
    const coordinator = new VisibilityMappingCoordinator({
      filteringRequested: () => true,
      getCommands: () => {
        commandReads += 1;
        return Promise.resolve(extraProvider
          ? [...native.discoveryCommands, `${visibilityCommandPrefix}scm9`]
          : native.discoveryCommands);
      },
      getRepositories: () => native.repositories,
      multipleSelectionMode: () => true,
      minimumRepositoryCount: () => 2,
      reconciler,
      commandRetryAttempts: 1,
      probeTimings: { probeMilliseconds: 1, selectionTimeoutMilliseconds: 1 },
      topologySettleMilliseconds: 0,
    });

    coordinator.requestRefresh();
    await coordinator.waitForIdle();
    expect(coordinator.mappingState).toBe('other-scm-providers');

    // Nothing in VS Code announces another provider going away, so the manual
    // refresh is the retry.
    extraProvider = false;
    coordinator.retryIfUnavailable();
    await coordinator.waitForIdle();
    expect(coordinator.baselineEstablished).toBe(true);
    expect(reconciler.hiddenRepositoryCount).toBe(2);

    const readsAfterMapping = commandReads;
    coordinator.retryIfUnavailable();
    await coordinator.waitForIdle();
    expect(commandReads).toBe(readsAfterMapping);
    expect(reconciler.hiddenRepositoryCount).toBe(2);
  });

  it('fails compatibility when the native selection-mode command family disappears', async () => {
    const native = nativeRepositories(['alpha', 'beta']);
    const onError = vi.fn();
    const reconciler = new VisibilityReconciler({ toggle: native.execute, onError });
    const coordinator = new VisibilityMappingCoordinator({
      filteringRequested: () => true,
      // The per-repository family is intact; its eagerly-registered sibling is not.
      getCommands: () => Promise.resolve(native.commands),
      getRepositories: () => native.repositories,
      multipleSelectionMode: () => true,
      minimumRepositoryCount: () => 2,
      reconciler,
      commandRetryAttempts: 1,
      topologySettleMilliseconds: 0,
    });

    coordinator.requestRefresh();
    await coordinator.waitForIdle();

    expect(reconciler.compatible).toBe(false);
    const reported: unknown = onError.mock.calls[0][0];
    expect(reported).toBeInstanceOf(Error);
    expect((reported as Error).message).toContain('selection-mode commands');
  });

  it('surfaces command-enumeration failures instead of treating them as lazy registration', async () => {
    const native = nativeRepositories(['alpha', 'beta']);
    const failure = new Error('command registry unavailable');
    const onError = vi.fn();
    const reconciler = new VisibilityReconciler({ toggle: native.execute, onError });
    const coordinator = new VisibilityMappingCoordinator({
      filteringRequested: () => true,
      getCommands: () => Promise.reject(failure),
      getRepositories: () => native.repositories,
      multipleSelectionMode: () => true,
      minimumRepositoryCount: () => 2,
      reconciler,
      commandRetryAttempts: 1,
      topologySettleMilliseconds: 0,
    });

    coordinator.requestRefresh();
    await coordinator.waitForIdle();

    expect(reconciler.compatible).toBe(false);
    expect(onError.mock.calls[0][0]).toBe(failure);
  });

  it('waits for the Git API initial scan before discovering or toggling repositories', async () => {
    const native = nativeRepositories(['alpha', 'beta']);
    const onUnavailable = vi.fn();
    const execute = vi.fn(native.execute);
    const getCommands = vi.fn(() => Promise.resolve(native.discoveryCommands));
    const reconciler = new VisibilityReconciler({ toggle: execute });
    for (const repository of native.repositories) reconciler.setActionability(repository, clean);
    let ready = false;
    const coordinator = new VisibilityMappingCoordinator({
      filteringRequested: () => true,
      getCommands,
      getRepositories: () => native.repositories,
      topologyReady: () => ready,
      multipleSelectionMode: () => true,
      minimumRepositoryCount: () => 2,
      reconciler,
      onUnavailable,
      probeTimings: { probeMilliseconds: 1 },
      topologySettleMilliseconds: 0,
    });

    coordinator.requestRefresh();
    await coordinator.waitForIdle();

    expect(coordinator.mappingState).toBe('loading-repositories');
    expect(onUnavailable).toHaveBeenCalledWith('loading-repositories');
    expect(getCommands).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();

    ready = true;
    coordinator.requestRefresh();
    await coordinator.waitForIdle();

    expect(coordinator.baselineEstablished).toBe(true);
    expect(reconciler.hiddenRepositoryCount).toBe(2);
  });

  it('resets a hidden startup baseline once and then maps from the recovered state', async () => {
    const native = nativeRepositories(['alpha', 'beta']);
    let recovered = false;
    const recoverHiddenBaseline = vi.fn(async () => { recovered = true; });
    const toggle = vi.fn((command: string) => recovered ? native.execute(command) : Promise.resolve());
    const reconciler = new VisibilityReconciler({ toggle });
    for (const repository of native.repositories) reconciler.setActionability(repository, clean);
    const coordinator = new VisibilityMappingCoordinator({
      filteringRequested: () => true,
      getCommands: () => Promise.resolve(native.discoveryCommands),
      getRepositories: () => native.repositories,
      recoverHiddenBaseline,
      multipleSelectionMode: () => true,
      minimumRepositoryCount: () => 2,
      reconciler,
      probeTimings: { probeMilliseconds: 1 },
      topologySettleMilliseconds: 0,
    });

    coordinator.requestRefresh();
    await coordinator.waitForIdle();

    expect(recoverHiddenBaseline).toHaveBeenCalledOnce();
    expect(coordinator.baselineEstablished).toBe(true);
  });

  it('audits a healthy mapping without probing or toggling it again', async () => {
    const fixture = coordinatorFixture(['alpha', 'beta']);
    fixture.coordinator.requestRefresh();
    await fixture.coordinator.waitForIdle();
    const togglesAfterMapping = fixture.execute.mock.calls.length;
    const commandReadsAfterMapping = fixture.getCommands.mock.calls.length;

    await fixture.coordinator.audit();
    await fixture.coordinator.waitForIdle();

    expect(fixture.getCommands).toHaveBeenCalledTimes(commandReadsAfterMapping + 1);
    expect(fixture.execute).toHaveBeenCalledTimes(togglesAfterMapping);
    expect(fixture.coordinator.baselineEstablished).toBe(true);
  });

  it('aborts an in-flight mapping transaction before processing a newer topology', async () => {
    const initialized = vi.fn();
    const native = nativeRepositories(['alpha']);
    let requestedDuringTransaction = false;
    const execute = vi.fn(async (command: string) => {
      if (!requestedDuringTransaction) {
        requestedDuringTransaction = true;
        coordinator.requestRefresh();
      }
      await native.execute(command);
    });
    const reconciler = new VisibilityReconciler({ toggle: execute });
    reconciler.setActionability(native.repositories[0], clean);
    const coordinator = new VisibilityMappingCoordinator({
      filteringRequested: () => true,
      getCommands: () => Promise.resolve(native.discoveryCommands),
      getRepositories: () => native.repositories,
      multipleSelectionMode: () => true,
      minimumRepositoryCount: () => 1,
      onInitialized: initialized,
      reconciler,
      probeTimings: { probeMilliseconds: 1 },
      topologySettleMilliseconds: 0,
    });

    coordinator.requestRefresh();
    await coordinator.waitForIdle();

    expect(requestedDuringTransaction).toBe(true);
    expect(initialized).toHaveBeenCalledOnce();
    expect(coordinator.baselineEstablished).toBe(true);
    expect(reconciler.hiddenRepositoryCount).toBe(1);
  });
});
