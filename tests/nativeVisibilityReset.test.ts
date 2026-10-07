import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventLike } from '../src/gitApi';
import {
  NativeVisibilityResetter,
  resetNativeRepositoryVisibility,
} from '../src/nativeVisibilityReset';
import { selectionModeCommands } from '../src/visibilityCommandResolver';
import { NativeVisibilityCommandExecutor } from '../src/nativeVisibilityCommandExecutor';

function modeEvent(): {
  readonly event: EventLike<void>;
  fire(): void;
  listenerCount(): number;
} {
  const listeners = new Set<() => void>();
  return {
    event: listener => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    fire: () => { for (const listener of listeners) listener(); },
    listenerCount: () => listeners.size,
  };
}

describe('resetNativeRepositoryVisibility', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits for both configuration transitions and restores multiple mode', async () => {
    const changed = modeEvent();
    let mode = 'multiple';
    const executeCommand = vi.fn(async (command: string) => {
      const next = command === selectionModeCommands.single ? 'single' : 'multiple';
      setTimeout(() => {
        mode = next;
        changed.fire();
      }, 5);
    });

    const reset = resetNativeRepositoryVisibility({
      executeCommand,
      getSelectionMode: () => mode,
      onDidChangeSelectionMode: changed.event,
      timeoutMilliseconds: 100,
    });

    await vi.advanceTimersByTimeAsync(10);
    await reset;
    expect(executeCommand.mock.calls).toEqual([
      [selectionModeCommands.single],
      [selectionModeCommands.multiple],
    ]);
    expect(mode).toBe('multiple');
    expect(changed.listenerCount()).toBe(0);
  });

  it('fails within the bound when VS Code never reports the requested mode', async () => {
    const changed = modeEvent();

    const result = expect(resetNativeRepositoryVisibility({
      executeCommand: async () => {},
      getSelectionMode: () => 'multiple',
      onDidChangeSelectionMode: changed.event,
      timeoutMilliseconds: 10,
    })).rejects.toThrow('did not settle repository selection mode "single"');

    await vi.advanceTimersByTimeAsync(10);
    await result;
    expect(changed.listenerCount()).toBe(0);
  });

  it('coalesces concurrent reset requests into one native transition', async () => {
    const changed = modeEvent();
    let mode = 'multiple';
    const executeCommand = vi.fn(async (command: string) => {
      mode = command === selectionModeCommands.single ? 'single' : 'multiple';
      changed.fire();
    });
    const resetter = new NativeVisibilityResetter({
      executeCommand,
      getSelectionMode: () => mode,
      onDidChangeSelectionMode: changed.event,
      onForeignDeparture: () => {},
      onForeignReset: () => {},
      timeoutMilliseconds: 100,
    });

    const first = resetter.reset();
    const second = resetter.reset();
    expect(second).toBe(first);
    await Promise.all([first, second]);
    expect(executeCommand).toHaveBeenCalledTimes(2);

    await resetter.reset();
    expect(executeCommand).toHaveBeenCalledTimes(4);
  });

  it('shares one timeout across both selection-mode transitions', async () => {
    const changed = modeEvent();
    let mode = 'multiple';
    const executeCommand = vi.fn(async (command: string) => {
      if (command !== selectionModeCommands.single) return;
      setTimeout(() => {
        mode = 'single';
        changed.fire();
      }, 70);
    });
    const reset = resetNativeRepositoryVisibility({
      executeCommand,
      getSelectionMode: () => mode,
      onDidChangeSelectionMode: changed.event,
      timeoutMilliseconds: 100,
    });
    const result = expect(reset).rejects.toThrow(
      'did not settle repository selection mode "multiple"',
    );

    await vi.advanceTimersByTimeAsync(110);
    await result;
    expect(executeCommand).toHaveBeenCalledTimes(2);
  });
});

describe('reset command settlement', () => {
  const cleanup: (() => Promise<void>)[] = [];

  beforeEach(() => vi.useFakeTimers());
  afterEach(async () => {
    try {
      for (const dispose of cleanup.splice(0)) await dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  function heldCommands(executorBound = 10, resetBound = 100) {
    const changed = modeEvent();
    let mode = 'multiple';
    const gates = new Map<string, () => void>();
    const promises: Promise<unknown>[] = [];
    const execute = vi.fn((command: string) => new Promise<void>(resolve => {
      gates.set(command, resolve);
    }));
    const executor = new NativeVisibilityCommandExecutor({
      execute,
      timeoutMilliseconds: executorBound,
    });
    const onForeignDeparture = vi.fn();
    const onForeignReset = vi.fn();
    const resetter = new NativeVisibilityResetter({
      executeCommand: command => executor.execute(command),
      waitForCommandSettlement: (milliseconds, signal) => executor.waitForIdle(milliseconds, signal),
      getSelectionMode: () => mode,
      onDidChangeSelectionMode: changed.event,
      onForeignDeparture,
      onForeignReset,
      timeoutMilliseconds: resetBound,
    });
    cleanup.push(async () => {
      resetter.dispose();
      for (const resolve of gates.values()) resolve();
      await Promise.allSettled(promises);
      executor.dispose();
    });
    return {
      changed, execute, onForeignDeparture, onForeignReset, resetter,
      begin: () => {
        const reset = resetter.reset();
        // Teardown still owns a failed assertion's pending reset and raw gates.
        promises.push(reset);
        void reset.catch(() => {});
        return reset;
      },
      observe: (next: string) => { mode = next; changed.fire(); },
      settle: (command: string) => { gates.get(command)?.(); },
    };
  }

  it('waits for raw command settlement when the effective mode arrives first', async () => {
    const fixture = heldCommands();
    const reset = fixture.begin();
    await vi.advanceTimersByTimeAsync(0);
    fixture.observe('single');
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.execute).toHaveBeenCalledTimes(1);

    fixture.settle(selectionModeCommands.single);
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.execute.mock.calls.map(([command]) => command)).toEqual([
      selectionModeCommands.single, selectionModeCommands.multiple,
    ]);
    let done = false;
    void reset.then(() => { done = true; });
    fixture.observe('multiple');
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(false);
    fixture.settle(selectionModeCommands.multiple);
    await reset;
    expect(done).toBe(true);
    expect(fixture.onForeignDeparture).not.toHaveBeenCalled();
    expect(fixture.onForeignReset).not.toHaveBeenCalled();
  });

  it('waits for the effective mode when raw command settlement arrives first', async () => {
    const fixture = heldCommands();
    const reset = fixture.begin();
    await vi.advanceTimersByTimeAsync(0);
    fixture.settle(selectionModeCommands.single);
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.execute).toHaveBeenCalledTimes(1);
    fixture.observe('single');
    await vi.advanceTimersByTimeAsync(0);
    fixture.settle(selectionModeCommands.multiple);
    await vi.advanceTimersByTimeAsync(0);
    let done = false;
    void reset.then(() => { done = true; });
    expect(done).toBe(false);
    fixture.observe('multiple');
    await reset;
    expect(done).toBe(true);
  });

  it.each(['event-first', 'settlement-first'] as const)(
    'finishes a late single result inside the existing reset budget (%s)',
    async order => {
      const fixture = heldCommands();
      const reset = fixture.begin();
      await vi.advanceTimersByTimeAsync(10);
      expect(fixture.resetter.reset()).toBe(reset);
      expect(fixture.execute).toHaveBeenCalledTimes(1);

      if (order === 'event-first') fixture.observe('single');
      fixture.settle(selectionModeCommands.single);
      await vi.advanceTimersByTimeAsync(0);
      if (order === 'settlement-first') {
        expect(fixture.execute).toHaveBeenCalledTimes(1);
        fixture.observe('single');
        await vi.advanceTimersByTimeAsync(0);
      }
      fixture.observe('multiple');
      fixture.settle(selectionModeCommands.multiple);
      await reset;
      expect(fixture.execute).toHaveBeenCalledTimes(2);
      expect(fixture.onForeignDeparture).not.toHaveBeenCalled();
      expect(fixture.onForeignReset).not.toHaveBeenCalled();
    },
  );

  it('expires at the total reset deadline without certifying a later result', async () => {
    const fixture = heldCommands();
    const reset = fixture.begin();
    const result = expect(reset).rejects.toThrow('did not settle repository selection mode "single"');
    await vi.advanceTimersByTimeAsync(100);
    await result;
    fixture.observe('single');
    fixture.settle(selectionModeCommands.single);
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.execute).toHaveBeenCalledTimes(1);
    expect(fixture.onForeignDeparture).toHaveBeenCalledOnce();
    expect(fixture.changed.listenerCount()).toBe(1);
  });

  it('disposal ends a pending late-result wait and prevents a follow-up command', async () => {
    const fixture = heldCommands();
    const reset = fixture.begin();
    await vi.advanceTimersByTimeAsync(10);
    fixture.resetter.dispose();
    await expect(reset).rejects.toThrow('disposed');
    expect(vi.getTimerCount()).toBe(0);
    fixture.observe('single');
    fixture.settle(selectionModeCommands.single);
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.execute).toHaveBeenCalledTimes(1);
    expect(fixture.changed.listenerCount()).toBe(0);
    await expect(fixture.resetter.reset()).rejects.toThrow('disposed');
  });
});

describe('NativeVisibilityResetter selection-mode observation', () => {
  function observedResetter() {
    const changed = modeEvent();
    let mode = 'multiple';
    const onForeignDeparture = vi.fn();
    const onForeignReset = vi.fn();
    const resetter = new NativeVisibilityResetter({
      executeCommand: async command => {
        mode = command === selectionModeCommands.single ? 'single' : 'multiple';
        changed.fire();
      },
      getSelectionMode: () => mode,
      onDidChangeSelectionMode: changed.event,
      onForeignDeparture,
      onForeignReset,
      timeoutMilliseconds: 100,
    });
    const setForeignMode = (next: string): void => {
      mode = next;
      changed.fire();
    };
    return { changed, onForeignDeparture, onForeignReset, resetter, setForeignMode };
  }

  it("reports another window's brief single selection as a departure and an all-visible return", () => {
    const fixture = observedResetter();

    fixture.setForeignMode('single');
    expect(fixture.onForeignDeparture).toHaveBeenCalledOnce();
    expect(fixture.onForeignReset).not.toHaveBeenCalled();

    fixture.setForeignMode('multiple');
    expect(fixture.onForeignDeparture).toHaveBeenCalledOnce();
    expect(fixture.onForeignReset).toHaveBeenCalledOnce();
  });

  it('does not report its own reset as a foreign transition', async () => {
    const fixture = observedResetter();

    await fixture.resetter.reset();

    expect(fixture.onForeignDeparture).not.toHaveBeenCalled();
    expect(fixture.onForeignReset).not.toHaveBeenCalled();
  });

  it('ignores configuration events that leave the selection mode unchanged', () => {
    const fixture = observedResetter();

    fixture.setForeignMode('multiple');
    fixture.setForeignMode('single');
    fixture.setForeignMode('single');

    expect(fixture.onForeignDeparture).toHaveBeenCalledOnce();
    expect(fixture.onForeignReset).not.toHaveBeenCalled();
  });

  it('stops observing once disposed', () => {
    const fixture = observedResetter();

    fixture.resetter.dispose();

    expect(fixture.changed.listenerCount()).toBe(0);
  });
});
