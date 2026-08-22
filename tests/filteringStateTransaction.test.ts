import { describe, expect, it, vi } from 'vitest';
import {
  FilteringStateTransaction,
  FilteringStateTransitionError,
} from '../src/filteringStateTransaction';

describe('FilteringStateTransaction', () => {
  it('publishes runtime state only after native, durable, and context projections agree', async () => {
    const calls: string[] = [];
    const state = new FilteringStateTransaction({
      initialValue: true,
      applyNative: async value => { calls.push(`native:${value}`); },
      persist: async value => { calls.push(`persist:${value}`); },
      publishContext: async value => { calls.push(`context:${value}`); },
    });

    await expect(state.toggle()).resolves.toBe(false);
    expect(state.current).toBe(false);
    expect(calls).toEqual(['native:false', 'persist:false', 'context:false']);
  });

  it.each(['native', 'persist', 'context'] as const)(
    'reasserts every old projection when %s publication fails',
    async failureAt => {
      const calls: string[] = [];
      let failed = false;
      const operation = (name: string) => async (value: boolean) => {
        calls.push(`${name}:${value}`);
        if (name === failureAt && value === false && !failed) {
          failed = true;
          throw new Error(`${name} failed`);
        }
      };
      const state = new FilteringStateTransaction({
        initialValue: true,
        applyNative: operation('native'),
        persist: operation('persist'),
        publishContext: operation('context'),
      });

      await expect(state.toggle()).rejects.toBeInstanceOf(FilteringStateTransitionError);
      expect(state.current).toBe(true);
      expect(calls.slice(-3)).toEqual(['context:true', 'persist:true', 'native:true']);
    },
  );

  it('serializes rapid toggles against the last committed runtime value', async () => {
    const values: boolean[] = [];
    const state = new FilteringStateTransaction({
      initialValue: true,
      applyNative: async value => { values.push(value); },
      persist: async () => undefined,
      publishContext: async () => undefined,
    });

    const first = state.toggle();
    const second = state.toggle();
    await expect(Promise.all([first, second])).resolves.toEqual([false, true]);
    expect(state.current).toBe(true);
    expect(values).toEqual([false, true]);
  });

  it('retains every rollback failure for truthful recovery reporting', async () => {
    const rollbackFailure = new Error('context rollback failed');
    const state = new FilteringStateTransaction({
      initialValue: true,
      applyNative: async () => undefined,
      persist: async value => {
        if (!value) throw new Error('persist failed');
      },
      publishContext: async value => {
        if (value) throw rollbackFailure;
      },
    });

    const result = state.toggle().catch((error: unknown) => error);
    const error = await result;
    expect(error).toBeInstanceOf(FilteringStateTransitionError);
    expect((error as FilteringStateTransitionError).rollbackErrors).toEqual([rollbackFailure]);
    expect(state.current).toBe(true);
  });
});
