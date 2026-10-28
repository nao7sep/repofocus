import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  readonly close: (name: string) => void;
}

function nativeRepositories(
  names: readonly string[],
  commandOrder: readonly string[] = names,
  selectedAfterReset = commandOrder[0],
  staleFocusOnToggle?: number,
): NativeRepositoryFixture {
  const visible = new Set(names);
  const open = new Set(names);
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
    get commands() { return commands.filter(command => open.has(targets.get(command)!)); },
    get discoveryCommands() { return [selectionModeCommands.single, selectionModeCommands.multiple, ...this.commands]; },
    get repositories() { return repositories.filter(repository => open.has(repository.rootUri.fsPath.slice(1))); },
    visible,
    reset: async () => {
      for (const name of open) visible.add(name);
      selected = open.has(selectedAfterReset) ? selectedAfterReset : commandOrder.find(name => open.has(name));
    },
    execute: async command => {
      toggleCount += 1;
      const target = targets.get(command);
      if (!target || !open.has(target)) throw new Error(`Unexpected command: ${command}`);
      if (visible.delete(target)) {
        if (selected === target && toggleCount !== staleFocusOnToggle) {
          selected = commandOrder.find(name => visible.has(name));
        }
      } else {
        visible.add(target);
      }
    },
    close: name => {
      open.delete(name);
      visible.delete(name);
      if (selected === name) selected = commandOrder.find(candidate => visible.has(candidate));
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
    probeTimings: { selectionTimeoutMilliseconds: 20 },
    commandRetryMilliseconds: 0,
    topologySettleMilliseconds: 0,
  });
  return { coordinator, execute, getCommands, native, reconciler, resetNativeVisibility };
}

describe('VisibilityMappingCoordinator', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

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

  it('bounds the initial command-registration wait and then retries slowly until ready', async () => {
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
      commandUnavailableRetryMilliseconds: 1_000,
      topologySettleMilliseconds: 0,
    });

    coordinator.requestRefresh();
    vi.setSystemTime(new Date(0)); // Wall-clock correction cannot extend an elapsed deadline.
    await vi.advanceTimersByTimeAsync(10);
    await coordinator.waitForIdle();
    expect(getCommands).toHaveBeenCalledTimes(3);
    expect(coordinator.mappingState).toBe('awaiting-native-commands');

    commandsReady = true;
    await vi.advanceTimersByTimeAsync(1_000);
    await coordinator.waitForIdle();
    expect(coordinator.baselineEstablished).toBe(true);
    expect(getCommands).toHaveBeenCalledTimes(4);

    coordinator.refresh();
    await coordinator.waitForIdle();
    expect(getCommands).toHaveBeenCalledTimes(5);
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
    coordinator.updateFiltering();
    await coordinator.waitForIdle();
    expect(native.visible.size).toBe(2);

    filteringRequested = true;
    coordinator.updateFiltering();
    await coordinator.waitForIdle();
    expect(native.visible.size).toBe(0);
    expect(getCommands).toHaveBeenCalledTimes(3);
    expect(resetNativeVisibility).toHaveBeenCalledTimes(3);
  });

  it('turns off during command enumeration without touching native visibility', async () => {
    const native = nativeRepositories(['alpha', 'beta']);
    let resolveCommands!: (commands: readonly string[]) => void;
    let markStarted!: () => void;
    const gate = new Promise<readonly string[]>(resolve => { resolveCommands = resolve; });
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const getCommands = vi.fn(() => {
      markStarted();
      return gate;
    });
    const execute = vi.fn(native.execute);
    const resetNativeVisibility = vi.fn(native.reset);
    const reconciler = new VisibilityReconciler({ toggle: execute });
    for (const repository of native.repositories) reconciler.setActionability(repository, clean);
    let filteringRequested = true;
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
    await started;
    expect(coordinator.baselineEstablished).toBe(false);

    filteringRequested = false;
    coordinator.updateFiltering();
    expect(coordinator.baselineEstablished).toBe(false);

    resolveCommands(native.discoveryCommands);
    await coordinator.waitForIdle();
    expect(coordinator.baselineEstablished).toBe(false);
    expect(execute).not.toHaveBeenCalled();
    expect(resetNativeVisibility).not.toHaveBeenCalled();
    expect(reconciler.enabled).toBe(false);
  });

  it('stands down recoverably when another SCM provider is present', async () => {
    const native = nativeRepositories(['alpha', 'beta']);
    const onError = vi.fn();
    const onUnavailable = vi.fn();
    const execute = vi.fn(native.execute);
    const resetNativeVisibility = vi.fn(native.reset);
    const reconciler = new VisibilityReconciler({ toggle: execute, resetToAllVisible: native.reset, onError });
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

  it.each([true, false])('recovers a closed probe command before applying the latest filtering request: %s', async enabled => {
    const native = nativeRepositories(['alpha', 'beta', 'gamma']);
    const closed = native.repositories[0];
    const retiredCommand = native.commands[0];
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let started!: () => void;
    const issued = new Promise<void>(resolve => { started = resolve; });
    const execute = vi.fn(async (command: string) => {
      await native.execute(command);
      if (execute.mock.calls.length === 1) {
        started();
        await held;
      }
    });
    const onError = vi.fn();
    const resetNativeVisibility = vi.fn(native.reset);
    const reconciler = new VisibilityReconciler({ toggle: execute, resetToAllVisible: native.reset, onError });
    for (const repository of native.repositories) reconciler.setActionability(repository, clean);
    let filteringRequested = true;
    const coordinator = new VisibilityMappingCoordinator({
      filteringRequested: () => filteringRequested,
      getCommands: () => Promise.resolve(native.discoveryCommands),
      getRepositories: () => native.repositories,
      topologyReady: () => true,
      resetNativeVisibility,
      reconciler,
      topologySettleMilliseconds: 0,
    });
    try {
      coordinator.requestRefresh();
      await issued;
      native.close('alpha');
      reconciler.removeRepository(closed);
      filteringRequested = enabled;
      coordinator.requestRefresh();
      release();
      await coordinator.waitForIdle();

      expect(execute.mock.calls.filter(([command]) => command === retiredCommand)).toHaveLength(1);
      expect(onError).not.toHaveBeenCalled();
      expect(reconciler.compatible).toBe(true);
      expect(coordinator.baselineEstablished).toBe(enabled);
      expect(native.visible).toEqual(new Set(enabled ? [] : ['beta', 'gamma']));
      expect(reconciler.hiddenRepositoryCount).toBe(enabled ? 2 : 0);
    } finally {
      release();
      coordinator.dispose();
      reconciler.dispose();
    }
  });

  it('keeps a newer foreign all-visible hint when an older reset finishes', async () => {
    const fixture = coordinatorFixture(['alpha', 'beta']);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let markStarted!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const resetNativeVisibility = vi.fn(async () => {
      markStarted();
      await gate;
      await fixture.native.reset();
    });
    const coordinator = new VisibilityMappingCoordinator({
      filteringRequested: () => true,
      getCommands: fixture.getCommands,
      getRepositories: () => fixture.native.repositories,
      topologyReady: () => true,
      resetNativeVisibility,
      reconciler: fixture.reconciler,
      topologySettleMilliseconds: 0,
    });
    try {
      coordinator.requestRefresh();
      await started;
      expect(resetNativeVisibility).toHaveBeenCalledOnce();
      await fixture.native.reset();
      coordinator.acceptForeignReset();
      release();
      await coordinator.waitForIdle();

      expect(resetNativeVisibility).toHaveBeenCalledOnce();
      expect(coordinator.baselineEstablished).toBe(true);
      expect(fixture.native.visible.size).toBe(0);
      expect(fixture.reconciler.hiddenRepositoryCount).toBe(2);
    } finally {
      coordinator.dispose();
      release();
      await coordinator.waitForIdle();
      fixture.reconciler.dispose();
      fixture.coordinator.dispose();
    }
  });

  it('uses a foreign all-visible reset when it interrupts a probe waiting for focus', async () => {
    const native = nativeRepositories(['alpha', 'beta'], ['alpha', 'beta'], 'beta', 3);
    let markThirdToggle!: () => void;
    const thirdToggle = new Promise<void>(resolve => { markThirdToggle = resolve; });
    const execute = vi.fn(async (command: string) => {
      await native.execute(command);
      if (execute.mock.calls.length === 3) markThirdToggle();
    });
    const onError = vi.fn();
    const reconciler = new VisibilityReconciler({ toggle: execute, resetToAllVisible: native.reset, onError });
    for (const repository of native.repositories) reconciler.setActionability(repository, clean);
    const resetNativeVisibility = vi.fn(native.reset);
    const coordinator = new VisibilityMappingCoordinator({
      filteringRequested: () => true,
      getCommands: () => Promise.resolve(native.discoveryCommands),
      getRepositories: () => native.repositories,
      topologyReady: () => true,
      resetNativeVisibility,
      reconciler,
      topologySettleMilliseconds: 0,
    });
    try {
      coordinator.requestRefresh();
      await thirdToggle;
      await vi.advanceTimersByTimeAsync(0);
      expect(reconciler.toggling).toBe(false);
      await native.reset();
      coordinator.acceptForeignReset();
      await vi.advanceTimersByTimeAsync(10);
      await coordinator.waitForIdle();

      expect(resetNativeVisibility).toHaveBeenCalledOnce();
      expect(onError).not.toHaveBeenCalled();
      expect(coordinator.baselineEstablished).toBe(true);
      expect(native.visible.size).toBe(0);
    } finally {
      coordinator.dispose();
      reconciler.dispose();
    }
  });

  it('fails compatibility without hiding anything when the native reset fails', async () => {
    const native = nativeRepositories(['alpha', 'beta']);
    const failure = new Error('native reset failed');
    const onError = vi.fn();
    const execute = vi.fn(native.execute);
    const reconciler = new VisibilityReconciler({ toggle: execute, resetToAllVisible: native.reset, onError });
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

  it.each([false, true])('retries a partial reset without inverting the old ledger (mapped: %s)', async mapped => {
    const native = nativeRepositories(['alpha', 'beta']);
    let filteringRequested = true;
    let failReset = !mapped;
    const execute = vi.fn(native.execute);
    const resetToAllVisible = vi.fn(native.reset);
    const resetNativeVisibility = vi.fn(async () => {
      if (!failReset) return native.reset();
      // The single-selection half succeeds; returning to multiple fails.
      native.visible.clear();
      native.visible.add('alpha');
      throw new Error('return to multiple failed');
    });
    const reconciler = new VisibilityReconciler({ toggle: execute, resetToAllVisible });
    for (const repository of native.repositories) reconciler.setActionability(repository, clean);
    const coordinator = new VisibilityMappingCoordinator({
      filteringRequested: () => filteringRequested,
      getCommands: () => Promise.resolve(native.discoveryCommands),
      getRepositories: () => native.repositories,
      topologyReady: () => true,
      resetNativeVisibility,
      reconciler,
      commandRetryAttempts: 1,
      topologySettleMilliseconds: 0,
    });
    if (mapped) {
      coordinator.requestRefresh();
      await coordinator.waitForIdle();
      expect(native.visible.size).toBe(0);
      execute.mockClear();
      failReset = true;
    }
    coordinator.requestRefresh();
    await coordinator.waitForIdle();
    expect(coordinator.baselineEstablished).toBe(false);
    expect(reconciler.compatible).toBe(false);
    expect(execute).not.toHaveBeenCalled();
    expect(resetToAllVisible).not.toHaveBeenCalled();

    filteringRequested = false;
    coordinator.updateFiltering();
    await coordinator.waitForIdle();
    expect(resetToAllVisible).toHaveBeenCalledOnce();
    expect(native.visible).toEqual(new Set(['alpha', 'beta']));
    expect(execute).not.toHaveBeenCalled();
    expect(reconciler.hiddenRepositoryCount).toBe(0);
    coordinator.dispose();
    reconciler.dispose();
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
    const reconciler = new VisibilityReconciler({ toggle: execute, resetToAllVisible: native.reset, onError });
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
    await vi.advanceTimersByTimeAsync(20);
    await coordinator.waitForIdle();

    expect(reconciler.compatible).toBe(false);
    expect(native.visible.size).toBe(3);
    expect(execute).toHaveBeenCalledTimes(5);
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

  it("re-maps without a reset of its own after another window's brief single selection", async () => {
    const fixture = coordinatorFixture(['alpha', 'beta']);
    fixture.coordinator.requestRefresh();
    await fixture.coordinator.waitForIdle();
    expect(fixture.native.visible.size).toBe(0);

    // VS Code shows every repository when the selection mode returns to multiple.
    fixture.coordinator.requestRefresh();
    void fixture.native.reset();
    fixture.coordinator.acceptForeignReset();
    await fixture.coordinator.waitForIdle();

    expect(fixture.resetNativeVisibility).toHaveBeenCalledOnce();
    expect(fixture.coordinator.baselineEstablished).toBe(true);
    expect(fixture.reconciler.hiddenRepositoryCount).toBe(2);
    expect(fixture.native.visible.size).toBe(0);

    fixture.coordinator.requestRefresh();
    await fixture.coordinator.waitForIdle();
    expect(fixture.resetNativeVisibility).toHaveBeenCalledTimes(2);
  });

  it('resets for itself when a toggle was in flight across a foreign return to multiple', async () => {
    const native = nativeRepositories(['alpha', 'beta']);
    let release: (() => void) | undefined;
    let markHeld!: () => void;
    const held = new Promise<void>(resolve => { markHeld = resolve; });
    const execute = vi.fn(async (command: string) => {
      if (release === undefined) {
        await new Promise<void>(resolve => { release = resolve; markHeld(); });
      }
      await native.execute(command);
    });
    const resetNativeVisibility = vi.fn(native.reset);
    const reconciler = new VisibilityReconciler({ toggle: execute });
    for (const repository of native.repositories) reconciler.setActionability(repository, clean);
    const coordinator = new VisibilityMappingCoordinator({
      filteringRequested: () => true,
      getCommands: () => Promise.resolve(native.discoveryCommands),
      getRepositories: () => native.repositories,
      topologyReady: () => true,
      resetNativeVisibility,
      reconciler,
      probeTimings: { selectionTimeoutMilliseconds: 20 },
      commandRetryMilliseconds: 0,
      topologySettleMilliseconds: 0,
    });

    coordinator.requestRefresh();
    await held;
    expect(reconciler.toggling).toBe(true);
    coordinator.acceptForeignReset();
    release?.();
    await coordinator.waitForIdle();

    expect(resetNativeVisibility).toHaveBeenCalledTimes(2);
    expect(coordinator.baselineEstablished).toBe(true);
    expect(native.visible.size).toBe(0);
  });

  it('ends a pending settle wait and clears its timer when disposed', async () => {
    const native = nativeRepositories(['alpha', 'beta']);
    const getCommands = vi.fn(() => Promise.resolve(native.discoveryCommands));
    const coordinator = new VisibilityMappingCoordinator({
      filteringRequested: () => true,
      getCommands,
      getRepositories: () => native.repositories,
      topologyReady: () => true,
      resetNativeVisibility: native.reset,
      reconciler: new VisibilityReconciler({ toggle: native.execute }),
      topologySettleMilliseconds: 60_000,
    });

    coordinator.requestRefresh();
    coordinator.dispose();
    await coordinator.waitForIdle();

    expect(vi.getTimerCount()).toBe(0);
    expect(getCommands).not.toHaveBeenCalled();
  });
  it('reapplies from native truth after a manual reveal and an actionable transition', async () => {
    const f = coordinatorFixture(['alpha', 'beta']);
    f.coordinator.requestRefresh(); await f.coordinator.waitForIdle();
    await f.native.execute(f.native.commands[0]); // A native manual reveal bypasses RepoFocus.
    f.reconciler.setActionability(f.native.repositories[0], { actionable: true, reasons: [] });
    await f.coordinator.waitForIdle();
    expect(f.native.visible).toEqual(new Set(['alpha']));
    expect(f.resetNativeVisibility).toHaveBeenCalledTimes(2);
    const calls = f.execute.mock.calls.length;
    f.reconciler.setActionability(f.native.repositories[0], { actionable: true, reasons: [{ kind: 'unstaged', count: 2 }] });
    await f.coordinator.waitForIdle(); expect(f.execute).toHaveBeenCalledTimes(calls);
    await f.native.execute(f.native.commands[0]); // Manual hide persists until explicit refresh.
    f.coordinator.refresh(); await f.coordinator.waitForIdle();
    expect(f.native.visible).toEqual(new Set(['alpha']));
  });

  it('retains surviving identities on closure and a settled foreign reset', async () => {
    const f = coordinatorFixture(['alpha', 'beta', 'gamma']);
    f.coordinator.requestRefresh(); await f.coordinator.waitForIdle();
    const closed = f.native.repositories[0]; f.native.close('alpha'); f.reconciler.removeRepository(closed);
    f.execute.mockClear(); f.coordinator.requestRefresh(); await f.coordinator.waitForIdle();
    expect(f.execute).toHaveBeenCalledTimes(2); // Only the final hides, no probe.
    const resets = f.resetNativeVisibility.mock.calls.length;
    await f.native.reset(); f.execute.mockClear(); f.coordinator.acceptForeignReset();
    await f.coordinator.waitForIdle();
    expect(f.execute).toHaveBeenCalledTimes(2); expect(f.resetNativeVisibility).toHaveBeenCalledTimes(resets);
  });

  it('never consumes a superseded command snapshot after equal-count provider replacement', async () => {
    const old = nativeRepositories(['old', 'beta']);
    const next = nativeRepositories(['new', 'beta']);
    let repositories = old.repositories;
    let release!: (commands: readonly string[]) => void;
    const held = new Promise<readonly string[]>(resolve => { release = resolve; });
    const fresh = next.discoveryCommands.map(command => command.replace(/scm(\d+)$/, (_match, number) => `scm${Number(number) + 10}`));
    const getCommands = vi.fn().mockImplementationOnce(() => held).mockResolvedValue(fresh);
    const toggle = vi.fn(async (command: string) => next.execute(command.replace(/scm(\d+)$/, (_match, number) => `scm${Number(number) - 10}`)));
    const reconciler = new VisibilityReconciler({ toggle });
    next.repositories.forEach(r => reconciler.setActionability(r, clean));
    const coordinator = new VisibilityMappingCoordinator({
      filteringRequested: () => true, getCommands, getRepositories: () => repositories,
      topologyReady: () => true, resetNativeVisibility: next.reset, reconciler,
      topologySettleMilliseconds: 0,
    });
    coordinator.requestRefresh(); await vi.advanceTimersByTimeAsync(0);
    repositories = next.repositories; coordinator.requestRefresh(); await vi.advanceTimersByTimeAsync(0);
    expect(getCommands).toHaveBeenCalledOnce(); release(old.discoveryCommands); await coordinator.waitForIdle();
    expect(getCommands).toHaveBeenCalledTimes(2);
    expect(toggle.mock.calls.every(([command]) => /scm1[01]$/.test(command))).toBe(true);
    expect(next.visible.size).toBe(0); coordinator.dispose();
  });

  it('cancels Off during a held probe command and restores after settlement', async () => {
    const native = nativeRepositories(['alpha', 'beta']); let enabled = true;
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    const toggle = vi.fn(async (command: string) => { await native.execute(command); if (toggle.mock.calls.length === 1) await held; });
    const reconciler = new VisibilityReconciler({ toggle }); const reset = vi.fn(native.reset);
    const coordinator = new VisibilityMappingCoordinator({ filteringRequested: () => enabled,
      getCommands: async () => native.discoveryCommands, getRepositories: () => native.repositories,
      topologyReady: () => true, resetNativeVisibility: reset, reconciler, topologySettleMilliseconds: 0 });
    coordinator.requestRefresh(); await vi.advanceTimersByTimeAsync(0);
    expect(toggle).toHaveBeenCalledOnce(); enabled = false; coordinator.updateFiltering();
    expect(reset).toHaveBeenCalledOnce(); release(); await coordinator.waitForIdle();
    expect(toggle).toHaveBeenCalledOnce(); expect(reset).toHaveBeenCalledTimes(2);
    expect(native.visible.size).toBe(2); expect(coordinator.baselineEstablished).toBe(false);
  });

  it('restores a selected eligible repository after discovery and skips a filtered selection', async () => {
    const native = nativeRepositories(['alpha', 'beta'], ['beta', 'alpha'], 'alpha');
    const reconciler = new VisibilityReconciler({ toggle: native.execute });
    const coordinator = new VisibilityMappingCoordinator({ filteringRequested: () => true,
      getCommands: async () => native.discoveryCommands, getRepositories: () => native.repositories,
      topologyReady: () => true, resetNativeVisibility: native.reset, reconciler, topologySettleMilliseconds: 0 });
    coordinator.requestRefresh(); await coordinator.waitForIdle();
    expect(native.repositories.find(r => r.ui.selected)?.rootUri.fsPath).toBe('/beta');
    reconciler.setActionability(native.repositories[1], clean); await coordinator.waitForIdle();
    expect(native.visible).toEqual(new Set(['alpha']));
    expect(native.repositories.find(r => r.ui.selected)?.rootUri.fsPath).toBe('/alpha');
  });

  it.each(['reset', 'focus', 'apply'])('honors Off during %s and a subsequent On request', async boundary => {
    const native = nativeRepositories(['alpha', 'beta'], ['alpha', 'beta'], 'beta', boundary === 'focus' ? 3 : undefined);
    let enabled = true; let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let issued!: () => void; const started = new Promise<void>(resolve => { issued = resolve; });
    let holdReset = boundary === 'reset';
    const reset = vi.fn(async () => { await native.reset(); if (holdReset) { holdReset = false; issued(); await held; } });
    const toggle = vi.fn(async (command: string) => {
      await native.execute(command);
      if ((boundary === 'focus' && toggle.mock.calls.length === 3)
        || (boundary === 'apply' && toggle.mock.calls.length === 4)) {
        issued(); if (boundary === 'apply') await held;
      }
    });
    const reconciler = new VisibilityReconciler({ toggle });
    native.repositories.forEach(r => reconciler.setActionability(r, clean));
    const coordinator = new VisibilityMappingCoordinator({ filteringRequested: () => enabled,
      getCommands: async () => native.discoveryCommands, getRepositories: () => native.repositories,
      topologyReady: () => true, resetNativeVisibility: reset, reconciler, topologySettleMilliseconds: 0 });
    coordinator.requestRefresh(); await started;
    const calls = toggle.mock.calls.length; enabled = false; coordinator.updateFiltering(); release();
    await vi.advanceTimersByTimeAsync(10); await coordinator.waitForIdle();
    expect(toggle).toHaveBeenCalledTimes(calls + (boundary === 'apply' ? 2 : 0));
    expect(native.visible.size).toBe(2);
    enabled = true; coordinator.updateFiltering(); await coordinator.waitForIdle();
    expect(native.visible.size).toBe(0); expect(coordinator.baselineEstablished).toBe(true);
  });

  it('does not reset a newly mixed-provider window during reapplication', async () => {
    const f = coordinatorFixture(['alpha', 'beta']);
    f.coordinator.requestRefresh(); await f.coordinator.waitForIdle();
    f.getCommands.mockResolvedValue([...f.native.discoveryCommands, `${visibilityCommandPrefix}scm99`]);
    f.reconciler.setActionability(f.native.repositories[0], { actionable: true, reasons: [] });
    await vi.advanceTimersByTimeAsync(1000); await f.coordinator.waitForIdle();
    expect(f.coordinator.mappingState).toBe('other-scm-providers');
    expect(f.resetNativeVisibility).toHaveBeenCalledOnce();
  });

});
