import { describe, expect, it, vi } from 'vitest';
import {
  NativeVisibilityCommandBusyError,
  NativeVisibilityCommandExecutor,
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

  it('rejects new commands after disposal', async () => {
    const execute = vi.fn(() => Promise.resolve());
    const executor = new NativeVisibilityCommandExecutor({ execute });
    executor.dispose();

    await expect(executor.execute('toggle.alpha')).rejects.toThrow('disposed');
    expect(execute).not.toHaveBeenCalled();
  });
});
