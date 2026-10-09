import { describe, expect, it, vi } from 'vitest';
import { FilteringPreference, readStoredFilteringEnabled } from '../src/filteringPreference';
import { HostOperationTimeoutError } from '../src/hostOperation';

describe('readStoredFilteringEnabled', () => {
  it.each([true, false])('keeps a stored boolean %s', stored => {
    expect(readStoredFilteringEnabled(stored)).toBe(stored);
  });

  it.each([undefined, null, 'false', 0, 1, {}])('reads %j as the default, enabled', stored => {
    expect(readStoredFilteringEnabled(stored)).toBe(true);
  });
});

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function preference(overrides: Partial<ConstructorParameters<typeof FilteringPreference>[0]> = {}) {
  return new FilteringPreference({
    initialValue: true,
    apply: async () => {},
    persist: async () => {},
    publishContext: async () => {},
    hostWriteTimeoutMilliseconds: 1_000,
    ...overrides,
  });
}

describe('FilteringPreference', () => {
  it('applies the new preference and writes both projections', async () => {
    const calls: string[] = [];
    let state!: FilteringPreference;
    state = preference({
      apply: async () => { calls.push(`apply:${state.current}`); },
      persist: async value => { calls.push(`persist:${value}`); },
      publishContext: async value => { calls.push(`context:${value}`); },
    });

    await expect(state.toggle()).resolves.toEqual({ enabled: false });
    expect(state.current).toBe(false);
    expect(calls).toEqual(['apply:false', 'persist:false', 'context:false']);
  });

  it('keeps the requested preference and reports a failed save without reverting', async () => {
    const failure = new Error('storage failed');
    const apply = vi.fn(async () => {});
    const persist = vi.fn(async () => { throw failure; });
    const state = preference({ apply, persist });

    await expect(state.toggle()).resolves.toEqual({ enabled: false, saveError: failure });
    expect(state.current).toBe(false);
    expect(apply).toHaveBeenCalledOnce();
    expect(persist.mock.calls).toEqual([[false]]);
  });

  it('keeps the requested preference and reports a failed context key without reverting', async () => {
    const failure = new Error('context failed');
    const persist = vi.fn(async () => {});
    const state = preference({ persist, publishContext: async () => { throw failure; } });

    await expect(state.toggle()).resolves.toEqual({ enabled: false, contextError: failure });
    expect(state.current).toBe(false);
    expect(persist.mock.calls).toEqual([[false]]);
  });

  it('keeps the requested preference when native application fails', async () => {
    const failure = new Error('native failed');
    const persist = vi.fn(async () => {});
    const state = preference({ apply: async () => { throw failure; }, persist });

    await expect(state.toggle()).rejects.toBe(failure);
    expect(state.current).toBe(false);
    expect(persist.mock.calls).toEqual([[false]]);
  });

  it('alternates rapid toggles from the latest value', async () => {
    const applied: boolean[] = [];
    let state!: FilteringPreference;
    state = preference({ apply: async () => { applied.push(state.current); } });

    const results = await Promise.all([state.toggle(), state.toggle(), state.toggle()]);
    expect(results.map(result => result.enabled)).toEqual([false, true, false]);
    expect(state.current).toBe(false);
  });

  it('reports a save that outlives its wait and lets the next toggle proceed', async () => {
    vi.useFakeTimers();
    try {
      const firstWrite = deferred();
      const writes: boolean[] = [];
      const persist = vi.fn((value: boolean) => {
        writes.push(value);
        return writes.length === 1 ? firstWrite.promise : Promise.resolve();
      });
      const state = preference({ persist });

      const first = state.toggle();
      await vi.advanceTimersByTimeAsync(1_000);
      const firstResult = await first;
      expect(firstResult.enabled).toBe(false);
      expect(firstResult.saveError).toBeInstanceOf(HostOperationTimeoutError);

      // The next toggle is not blocked, but its write waits for the slow one.
      const second = state.toggle();
      await vi.advanceTimersByTimeAsync(0);
      expect(writes).toEqual([false]);

      firstWrite.resolve();
      await expect(second).resolves.toEqual({ enabled: true });
      expect(writes).toEqual([false, true]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never lets a late write land after a newer preference', async () => {
    const firstWrite = deferred();
    const stored: boolean[] = [];
    const persist = vi.fn((value: boolean) => {
      const write = persist.mock.calls.length === 1 ? firstWrite.promise : Promise.resolve();
      return write.then(() => { stored.push(value); });
    });
    const state = preference({ persist });

    const first = state.toggle();
    await vi.waitFor(() => expect(persist.mock.calls).toEqual([[false]]));
    const second = state.toggle();
    await Promise.resolve();
    expect(persist).toHaveBeenCalledOnce();
    firstWrite.resolve();
    await Promise.all([first, second]);

    expect(stored).toEqual([false, true]);
    expect(stored.at(-1)).toBe(state.current);
  });

  it('coalesces queued writes into one write of the latest value', async () => {
    const firstWrite = deferred();
    const persist = vi.fn((_value: boolean) =>
      persist.mock.calls.length === 1 ? firstWrite.promise : Promise.resolve());
    const state = preference({ persist });

    const toggles = [state.toggle(), state.toggle(), state.toggle()];
    firstWrite.resolve();
    await Promise.all(toggles);

    // The queued true and false cancel out, so nothing more is written.
    expect(persist.mock.calls).toEqual([[false]]);
    expect(state.current).toBe(false);
  });

  it('retries the latest value after a failed write', async () => {
    const written: boolean[] = [];
    const persist = vi.fn()
      .mockRejectedValueOnce(new Error('storage failed'))
      .mockImplementation(async (value: boolean) => { written.push(value); });
    const state = preference({ persist });

    expect((await state.toggle()).saveError).toBeInstanceOf(Error);
    await expect(state.toggle()).resolves.toEqual({ enabled: true });
    expect(written).toEqual([true]);
  });
});
