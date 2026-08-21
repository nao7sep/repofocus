import { describe, expect, it, vi } from 'vitest';
import {
  NativeVisibilityCommandBusyError,
  NativeVisibilityCommandExecutor,
  NativeVisibilityCommandIdleTimeoutError,
  NativeVisibilityCommandTimeoutError,
} from '../src/nativeVisibilityCommandExecutor';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('NativeVisibilityCommandExecutor', () => {
  it('times out a native command and refuses overlap until it actually settles', async () => {
    const gate = deferred();
    const execute = vi.fn(() => gate.promise);
    const executor = new NativeVisibilityCommandExecutor({ execute, timeoutMilliseconds: 10 });

    await expect(executor.execute('toggle.alpha'))
      .rejects.toBeInstanceOf(NativeVisibilityCommandTimeoutError);
    await expect(executor.execute('toggle.beta'))
      .rejects.toBeInstanceOf(NativeVisibilityCommandBusyError);
    expect(execute).toHaveBeenCalledOnce();

    gate.resolve();
    await gate.promise;
    await Promise.resolve();
    await expect(executor.execute('toggle.beta')).resolves.toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(2);
    executor.dispose();
  });

  it('clears the timeout timer after a successful command', async () => {
    vi.useFakeTimers();
    const execute = vi.fn(() => Promise.resolve());
    const executor = new NativeVisibilityCommandExecutor({ execute, timeoutMilliseconds: 50_000 });

    await executor.execute('toggle.alpha');
    expect(vi.getTimerCount()).toBe(0);
    executor.dispose();
    vi.useRealTimers();
  });

  it('waits for a timed-out command to settle without starting another command', async () => {
    const gate = deferred();
    const execute = vi.fn(() => gate.promise);
    const executor = new NativeVisibilityCommandExecutor({ execute, timeoutMilliseconds: 5 });

    await expect(executor.execute('toggle.alpha'))
      .rejects.toBeInstanceOf(NativeVisibilityCommandTimeoutError);
    const idle = executor.waitForIdle(50);
    gate.resolve();

    await expect(idle).resolves.toBeUndefined();
    expect(execute).toHaveBeenCalledOnce();
    executor.dispose();
  });

  it('bounds the wait for a native command that never settles', async () => {
    vi.useFakeTimers();
    const execute = vi.fn(() => new Promise<void>(() => {}));
    const executor = new NativeVisibilityCommandExecutor({ execute, timeoutMilliseconds: 5 });

    const command = executor.execute('toggle.alpha');
    const commandResult = expect(command).rejects
      .toBeInstanceOf(NativeVisibilityCommandTimeoutError);
    await vi.advanceTimersByTimeAsync(5);
    await commandResult;
    const idle = executor.waitForIdle(10);
    const idleResult = expect(idle).rejects
      .toBeInstanceOf(NativeVisibilityCommandIdleTimeoutError);
    await vi.advanceTimersByTimeAsync(10);
    await idleResult;

    executor.dispose();
    vi.useRealTimers();
  });

  it('rejects new commands after disposal', async () => {
    const execute = vi.fn(() => Promise.resolve());
    const executor = new NativeVisibilityCommandExecutor({ execute });
    executor.dispose();

    await expect(executor.execute('toggle.alpha')).rejects.toThrow('disposed');
    expect(execute).not.toHaveBeenCalled();
  });
});
