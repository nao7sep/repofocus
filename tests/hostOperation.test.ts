import { describe, expect, it, vi } from 'vitest';
import {
  HostOperationTimeoutError,
  NonOverlappingHostOperation,
  OneShotHostOperation,
} from '../src/hostOperation';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('host operations', () => {
  it('times out dependency activation without starting a second activation', async () => {
    const gate = deferred<string>();
    const start = vi.fn(() => gate.promise);
    const activation = new OneShotHostOperation<string>();

    await expect(activation.wait(start, 5, 'Git activation'))
      .rejects.toBeInstanceOf(HostOperationTimeoutError);
    const second = activation.wait(start, 50, 'Git activation');
    gate.resolve('ready');

    await expect(second).resolves.toBe('ready');
    expect(start).toHaveBeenCalledOnce();
  });

  it('retains a timed-out repeatable operation slot until the call really settles', async () => {
    const first = deferred<number>();
    const start = vi.fn(() => first.promise);
    const operation = new NonOverlappingHostOperation<number>();

    await expect(operation.wait(start, 5, 'command enumeration'))
      .rejects.toBeInstanceOf(HostOperationTimeoutError);
    const reused = operation.wait(start, 50, 'command enumeration');
    first.resolve(1);

    await expect(reused).resolves.toBe(1);
    expect(start).toHaveBeenCalledOnce();
  });

  it('clears its deadline timer after success', async () => {
    vi.useFakeTimers();
    const activation = new OneShotHostOperation<string>();
    await activation.wait(() => Promise.resolve('ready'), 50_000, 'Git activation');
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });
});
