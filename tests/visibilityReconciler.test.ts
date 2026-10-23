import { describe, expect, it, vi } from 'vitest';
import type { GitRepository } from '../src/gitApi';
import { VisibilityReconciler } from '../src/visibilityReconciler';

function fixture() {
  const visible = new Set(['a', 'b']);
  let selected: string | undefined = 'a';
  const repositories = ['a', 'b'].map(name => ({
    rootUri: { toString: () => name }, ui: { get selected() { return selected === name; } },
  })) as GitRepository[];
  const reset = vi.fn(async () => { visible.add('a'); visible.add('b'); selected = 'a'; });
  const toggle = vi.fn(async (name: string) => {
    if (visible.delete(name)) {
      if (selected === name) selected = [...visible][0];
    } else { visible.add(name); selected ??= name; }
  });
  const onError = vi.fn();
  const reconciler = new VisibilityReconciler({ toggle, resetToAllVisible: reset, onError });
  reconciler.setMappings(repositories.map(repository => ({ repository, command: repository.rootUri.toString() })));
  return { visible, repositories, reset, toggle, reconciler, onError, selected: () => selected };
}

describe('VisibilityReconciler batch application', () => {
  it('hides every clean repository, including the last one', async () => {
    const f = fixture(); f.reconciler.setFilteringEnabled(true);
    f.repositories.forEach(r => f.reconciler.setActionability(r, { actionable: false, reasons: [] }));
    await f.reconciler.apply(f.repositories, undefined, () => true);
    expect(f.visible.size).toBe(0); expect(f.reconciler.hiddenRepositoryCount).toBe(2);
  });
  it('restores eligible selection from the probe state before showing the rest', async () => {
    const f = fixture(); await f.reconciler.hide('b');
    await f.reconciler.apply(f.repositories, f.repositories[1], () => true);
    expect(f.visible).toEqual(new Set(['a', 'b'])); expect(f.selected()).toBe('b');
  });
  it('does not restore a filtered selection', async () => {
    const f = fixture(); f.reconciler.setFilteringEnabled(true);
    f.reconciler.setActionability(f.repositories[1], { actionable: false, reasons: [] });
    await f.reconciler.apply(f.repositories, f.repositories[1], () => true);
    expect(f.visible).toEqual(new Set(['a'])); expect(f.selected()).toBe('a');
  });
  it('notifies only a changed desired visibility, without issuing commands', () => {
    const f = fixture(); const changed = vi.fn(); f.reconciler.onDidChangeDesiredVisibility(changed);
    f.reconciler.setActionability(f.repositories[0], { actionable: true, reasons: [] });
    f.reconciler.setActionability(f.repositories[0], { actionable: true, reasons: [{ kind: 'unstaged', count: 3 }] });
    expect(changed).toHaveBeenCalledOnce(); expect(f.toggle).not.toHaveBeenCalled();
  });
  it('retains identities across resets and removes closed providers', async () => {
    const f = fixture(); await f.reconciler.hide('a'); f.reconciler.acceptAllVisible();
    expect(f.reconciler.hasMappings(f.repositories, ['a', 'b'])).toBe(true);
    expect(f.reconciler.hiddenRepositoryCount).toBe(0);
    f.reconciler.removeRepository(f.repositories[0]);
    expect(f.reconciler.hasMappings([f.repositories[1]], ['b'])).toBe(true);
    expect(f.reconciler.hasMappings(f.repositories, ['a', 'b'])).toBe(false);
  });
  it('rejects replacement wrappers and retired commands even at equal counts', () => {
    const f = fixture();
    expect(f.reconciler.hasMappings([{ ...f.repositories[0] }, f.repositories[1]], ['a', 'b'])).toBe(false);
    expect(f.reconciler.hasMappings(f.repositories, ['retired', 'b'])).toBe(false);
  });
  it('stops an obsolete application before its next mutation', async () => {
    const f = fixture(); f.reconciler.setFilteringEnabled(true);
    f.repositories.forEach(r => f.reconciler.setActionability(r, { actionable: false, reasons: [] }));
    await expect(f.reconciler.apply(f.repositories, undefined, () => f.toggle.mock.calls.length === 0)).rejects.toThrow('changed');
    expect(f.toggle).toHaveBeenCalledOnce();
  });
  it.each([false, true])('recovers ambiguous toggles by reset, never inversion (effect: %s)', async effect => {
    const f = fixture();
    const toggle = vi.fn(async () => { if (effect) f.visible.delete('a'); throw new Error('failed'); });
    const reconciler = new VisibilityReconciler({ toggle, resetToAllVisible: f.reset, onError: f.onError });
    await expect(reconciler.hide('a')).rejects.toThrow('failed'); await reconciler.restoreOwned();
    expect(toggle).toHaveBeenCalledOnce(); expect(f.reset).toHaveBeenCalledOnce();
    expect(f.visible.size).toBe(2); expect(reconciler.compatible).toBe(false); expect(f.onError).toHaveBeenCalledOnce();
  });
  it('allows explicit retry after recovery failure, but never acts on dispose', async () => {
    const reset = vi.fn().mockRejectedValueOnce(new Error('reset failed')).mockResolvedValue(undefined);
    const reconciler = new VisibilityReconciler({ toggle: async () => { throw new Error('failed'); }, resetToAllVisible: reset });
    await expect(reconciler.hide('a')).rejects.toThrow(); await reconciler.restoreOwned();
    expect(reset).toHaveBeenCalledTimes(2); reconciler.dispose(); await reconciler.restoreOwned(); expect(reset).toHaveBeenCalledTimes(2);
  });
});
