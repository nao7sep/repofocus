import { describe, expect, it, vi } from 'vitest';
import type { EventLike } from '../src/gitApi';
import {
  NativeVisibilityResetter,
  resetNativeRepositoryVisibility,
} from '../src/nativeVisibilityReset';
import { selectionModeCommands } from '../src/visibilityCommandResolver';

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

    await resetNativeRepositoryVisibility({
      executeCommand,
      getSelectionMode: () => mode,
      onDidChangeSelectionMode: changed.event,
      timeoutMilliseconds: 100,
    });

    expect(executeCommand.mock.calls).toEqual([
      [selectionModeCommands.single],
      [selectionModeCommands.multiple],
    ]);
    expect(mode).toBe('multiple');
    expect(changed.listenerCount()).toBe(0);
  });

  it('fails within the bound when VS Code never reports the requested mode', async () => {
    const changed = modeEvent();

    await expect(resetNativeRepositoryVisibility({
      executeCommand: async () => {},
      getSelectionMode: () => 'multiple',
      onDidChangeSelectionMode: changed.event,
      timeoutMilliseconds: 10,
    })).rejects.toThrow('did not enter repository selection mode "single"');

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
      timeoutMilliseconds: 100,
    });

    const first = resetter.reset();
    const second = resetter.reset();
    expect(second).toBe(first);
    await Promise.all([first, second]);

    expect(executeCommand).toHaveBeenCalledTimes(2);
    expect(resetter.running).toBe(false);
  });

  it('shares one timeout across both selection-mode transitions', async () => {
    vi.useFakeTimers();
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
      'did not enter repository selection mode "multiple"',
    );

    await vi.advanceTimersByTimeAsync(110);
    await result;
    expect(executeCommand).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
