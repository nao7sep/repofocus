import { describe, expect, it, vi } from 'vitest';
import { NativeVisibilityCommandExecutor } from '../src/nativeVisibilityCommandExecutor';

describe('NativeVisibilityCommandExecutor', () => {
  it('rejects new commands after disposal', async () => {
    const execute = vi.fn(() => Promise.resolve());
    const executor = new NativeVisibilityCommandExecutor({ execute });
    executor.dispose();

    await expect(executor.execute('toggle.alpha')).rejects.toThrow('disposed');
    expect(execute).not.toHaveBeenCalled();
  });
});
