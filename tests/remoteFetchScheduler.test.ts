import { describe, expect, it, vi } from 'vitest';
import { RemoteFetchScheduler, type RemoteFetchTarget } from '../src/remoteFetchScheduler';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('RemoteFetchScheduler', () => {
  it('bounds concurrency and fetches every target', async () => {
    let active = 0;
    let maximum = 0;
    const gates = Array.from({ length: 4 }, deferred);
    const targets: RemoteFetchTarget[] = gates.map((gate, index) => ({
      key: String(index),
      fetch: async () => {
        active += 1;
        maximum = Math.max(maximum, active);
        await gate.promise;
        active -= 1;
      },
    }));
    const scheduler = new RemoteFetchScheduler({ getTargets: () => targets, concurrency: 2 });

    const run = scheduler.refreshNow();
    await vi.waitFor(() => expect(active).toBe(2));
    gates[0].resolve();
    gates[1].resolve();
    await vi.waitFor(() => expect(active).toBe(2));
    gates[2].resolve();
    gates[3].resolve();
    await run;

    expect(maximum).toBe(2);
    scheduler.dispose();
  });

  it('coalesces requests made during a run without overlapping them', async () => {
    const first = deferred();
    let calls = 0;
    const target: RemoteFetchTarget = {
      key: 'repo',
      fetch: async () => {
        calls += 1;
        if (calls === 1) await first.promise;
      },
    };
    const scheduler = new RemoteFetchScheduler({ getTargets: () => [target] });

    const run = scheduler.refreshNow();
    await vi.waitFor(() => expect(calls).toBe(1));
    expect(scheduler.refreshNow()).toBe(run);
    first.resolve();
    await run;

    expect(calls).toBe(2);
    scheduler.dispose();
  });

  it('runs on an adjustable interval and zero disables the timer', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(() => Promise.resolve());
    const scheduler = new RemoteFetchScheduler({ getTargets: () => [{ key: 'repo', fetch }] });

    scheduler.setInterval(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await scheduler.waitForIdle();
    expect(fetch).toHaveBeenCalledTimes(1);

    scheduler.setInterval(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    scheduler.dispose();
    vi.useRealTimers();
  });

  it('reports failures and continues with other repositories', async () => {
    const onError = vi.fn();
    const onSuccess = vi.fn();
    const failed: RemoteFetchTarget = { key: 'failed', fetch: () => Promise.reject(new Error('offline')) };
    const healthy: RemoteFetchTarget = { key: 'healthy', fetch: () => Promise.resolve() };
    const scheduler = new RemoteFetchScheduler({ getTargets: () => [failed, healthy], onError, onSuccess });

    await scheduler.refreshNow();

    expect(onError).toHaveBeenCalledWith(failed, expect.any(Error));
    expect(onSuccess).toHaveBeenCalledWith(healthy);
    scheduler.dispose();
  });

  it('stops scheduling work when disposed', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(() => Promise.resolve());
    const scheduler = new RemoteFetchScheduler({ getTargets: () => [{ key: 'repo', fetch }] });
    scheduler.setInterval(100);
    scheduler.dispose();

    await vi.advanceTimersByTimeAsync(1_000);
    await scheduler.refreshNow();
    expect(fetch).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
