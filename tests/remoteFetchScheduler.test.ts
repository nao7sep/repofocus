import { describe, expect, it, vi } from 'vitest';
import { RemoteFetchScheduler, type RemoteFetchTarget } from '../src/remoteFetchScheduler';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('RemoteFetchScheduler', () => {
  it('clears a failure when the repository stops being a fetch target', async () => {
    // The repository stays open — only its eligibility goes away — so these
    // carry the same identity predicate production supplies.
    let targets: RemoteFetchTarget[] = [
      { key: 'alpha', isLive: () => true, fetch: () => Promise.reject(new Error('offline')) },
      { key: 'beta', isLive: () => true, fetch: () => Promise.resolve() },
    ];
    const scheduler = new RemoteFetchScheduler({ getTargets: () => targets });

    await scheduler.refreshNow();
    expect(scheduler.hasFailed('alpha')).toBe(true);
    expect(scheduler.hasFailed('beta')).toBe(false);
    expect(scheduler.failureCount).toBe(1);

    // The last remote removed, or both remote-detection policies disabled:
    // nothing can ever clear the failure by fetching again.
    targets = [];
    expect(scheduler.hasFailed('alpha')).toBe(false);
    expect(scheduler.failureCount).toBe(0);
    scheduler.dispose();
  });

  it('does not report a completion for a target that disappeared mid-fetch', async () => {
    const gate = deferred();
    const onSuccess = vi.fn();
    const onError = vi.fn();
    let targets: RemoteFetchTarget[] = [
      { key: 'alpha', isLive: () => true, fetch: () => gate.promise },
      { key: 'beta', isLive: () => true, fetch: () => Promise.reject(new Error('offline')) },
    ];
    const scheduler = new RemoteFetchScheduler({
      getTargets: () => targets,
      concurrency: 2,
      onSuccess,
      onError,
    });

    const run = scheduler.refreshNow();
    // The repository closes while its fetch is still in flight.
    targets = [];
    gate.resolve();
    await run;

    expect(onSuccess).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    scheduler.dispose();
  });

  it('does not report a completion for a target replaced at the same key', async () => {
    const gate = deferred();
    const onSuccess = vi.fn();
    const onError = vi.fn();
    // A repository closes and reopens at the same URI mid-fetch: same key,
    // different object. Reporting the old result would describe the new one.
    let closed = false;
    const original: RemoteFetchTarget = {
      key: 'file:///alpha',
      isLive: () => !closed,
      fetch: () => gate.promise,
    };
    const replacement: RemoteFetchTarget = {
      key: 'file:///alpha',
      isLive: () => true,
      fetch: () => Promise.resolve(),
    };
    let targets: RemoteFetchTarget[] = [original];
    const scheduler = new RemoteFetchScheduler({
      getTargets: () => targets,
      onSuccess,
      onError,
    });

    const run = scheduler.refreshNow();
    closed = true;
    targets = [replacement];
    gate.resolve();
    await run;

    expect(onSuccess).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(scheduler.hasFailed('file:///alpha')).toBe(false);
    scheduler.dispose();
  });

  it('does not attribute a stored failure to the repository that replaced the failed one', async () => {
    let closed = false;
    const original: RemoteFetchTarget = {
      key: 'file:///alpha',
      isLive: () => !closed,
      fetch: () => Promise.reject(new Error('offline')),
    };
    const replacement: RemoteFetchTarget = {
      key: 'file:///alpha',
      isLive: () => true,
      fetch: () => Promise.resolve(),
    };
    let targets: RemoteFetchTarget[] = [original];
    const scheduler = new RemoteFetchScheduler({ getTargets: () => targets });

    await scheduler.refreshNow();
    expect(scheduler.hasFailed('file:///alpha')).toBe(true);

    // Same URI, different repository: the failure belongs to its predecessor.
    closed = true;
    targets = [replacement];
    expect(scheduler.hasFailed('file:///alpha')).toBe(false);
    expect(scheduler.failureCount).toBe(0);
    scheduler.dispose();
  });

  it('clears a failure after a later successful fetch', async () => {
    let fail = true;
    const targets: RemoteFetchTarget[] = [
      { key: 'alpha', fetch: () => fail ? Promise.reject(new Error('offline')) : Promise.resolve() },
    ];
    const scheduler = new RemoteFetchScheduler({ getTargets: () => targets });

    await scheduler.refreshNow();
    expect(scheduler.hasFailed('alpha')).toBe(true);

    fail = false;
    await scheduler.refreshNow();
    expect(scheduler.hasFailed('alpha')).toBe(false);
    scheduler.dispose();
  });

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

// A `git fetch` can hang rather than fail — SSH waiting at a passphrase prompt
// on a non-tty, or a host that accepts the connection and never speaks. The
// await was unbounded, so the worker never returned, `drain` never resolved,
// and the `finally` that reschedules never ran: periodic auto-fetch stayed dead
// for the rest of the session, silently, and only a window reload brought it
// back. These pin the bound and, more importantly, the recovery.
describe('RemoteFetchScheduler bounds a hung fetch', () => {
  const hangsForever = (): Promise<void> => new Promise<void>(() => {});

  it('gives up on a fetch that never settles, and records it as a failure', async () => {
    const onError = vi.fn();
    const scheduler = new RemoteFetchScheduler({
      getTargets: () => [{ key: 'stuck', isLive: () => true, fetch: hangsForever }],
      fetchTimeoutMilliseconds: 20,
      onError,
    });

    // The whole point: this await used to never return.
    await scheduler.refreshNow();

    expect(scheduler.hasFailed('stuck')).toBe(true);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(String(onError.mock.calls[0][1])).toMatch(/did not finish within/i);
    scheduler.dispose();
  });

  it('keeps fetching other repositories, and keeps working on the next run', async () => {
    let healthyFetches = 0;
    const scheduler = new RemoteFetchScheduler({
      getTargets: () => [
        { key: 'stuck', isLive: () => true, fetch: hangsForever },
        {
          key: 'healthy',
          isLive: () => true,
          fetch: () => {
            healthyFetches += 1;
            return Promise.resolve();
          },
        },
      ],
      concurrency: 1,
      fetchTimeoutMilliseconds: 20,
    });

    await scheduler.refreshNow();
    expect(healthyFetches).toBe(1);
    expect(scheduler.hasFailed('healthy')).toBe(false);

    // The recovery that the silent death took away: a later run still happens.
    await scheduler.refreshNow();
    expect(healthyFetches).toBe(2);
    scheduler.dispose();
  });

  it('does not leave the timer pending after a fetch that finishes in time', async () => {
    const scheduler = new RemoteFetchScheduler({
      getTargets: () => [{ key: 'quick', isLive: () => true, fetch: () => Promise.resolve() }],
      fetchTimeoutMilliseconds: 50_000,
    });
    // A leaked 50s timer would hold the process open; vitest would hang here
    // rather than finishing this file.
    await scheduler.refreshNow();
    expect(scheduler.hasFailed('quick')).toBe(false);
    scheduler.dispose();
  });
});
