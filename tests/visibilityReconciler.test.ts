import { describe, expect, it, vi } from 'vitest';
import type { RepositoryActionability } from '../src/actionability';
import type { RepositoryIdentity, VisibilityMapping } from '../src/visibilityCommandResolver';
import { VisibilityReconciler } from '../src/visibilityReconciler';

function repository(name: string): RepositoryIdentity {
  return { rootUri: { toString: () => `file:///${name}` } };
}

function mapping(target: RepositoryIdentity, command: string): VisibilityMapping {
  return { repository: target, command };
}

const clean: RepositoryActionability = { actionable: false, reasons: [] };
const changed: RepositoryActionability = {
  actionable: true,
  reasons: [{ kind: 'unstaged', count: 1 }],
};

describe('VisibilityReconciler', () => {
  it('hides clean repositories and shows them when they become actionable', async () => {
    const alpha = repository('alpha');
    const toggle = vi.fn(async () => {});
    const reconciler = new VisibilityReconciler({ toggle });
    await reconciler.setFilteringEnabled(true);
    reconciler.setMappings([mapping(alpha, 'toggle.alpha')]);
    reconciler.setActionability(alpha, clean);
    await reconciler.waitForIdle();

    expect(toggle).toHaveBeenCalledWith('toggle.alpha');
    expect(reconciler.isHiddenByRepoFocus(alpha)).toBe(true);

    reconciler.setActionability(alpha, changed);
    await reconciler.waitForIdle();
    expect(toggle).toHaveBeenCalledTimes(2);
    expect(reconciler.isHiddenByRepoFocus(alpha)).toBe(false);
  });

  it('can hide every clean repository including the last one', async () => {
    const alpha = repository('alpha');
    const beta = repository('beta');
    const toggle = vi.fn(async () => {});
    const reconciler = new VisibilityReconciler({ toggle });
    await reconciler.setFilteringEnabled(true);
    reconciler.setMappings([mapping(alpha, 'toggle.alpha'), mapping(beta, 'toggle.beta')]);
    reconciler.setActionability(alpha, clean);
    reconciler.setActionability(beta, clean);
    await reconciler.waitForIdle();

    expect(toggle.mock.calls).toEqual([['toggle.alpha'], ['toggle.beta']]);
    expect(reconciler.isHiddenByRepoFocus(alpha)).toBe(true);
    expect(reconciler.isHiddenByRepoFocus(beta)).toBe(true);
  });

  it('does not toggle when repeated state has the same desired visibility', async () => {
    const alpha = repository('alpha');
    const toggle = vi.fn(async () => {});
    const reconciler = new VisibilityReconciler({ toggle });
    await reconciler.setFilteringEnabled(true);
    reconciler.setMappings([mapping(alpha, 'toggle.alpha')]);
    reconciler.setActionability(alpha, clean);
    reconciler.setActionability(alpha, clean);
    await reconciler.waitForIdle();
    reconciler.setActionability(alpha, clean);
    await reconciler.waitForIdle();

    expect(toggle).toHaveBeenCalledTimes(1);
  });

  it('reconciles directly from the visibility the probe left behind', async () => {
    const alpha = repository('alpha');
    const beta = repository('beta');
    const toggle = vi.fn(async () => {});
    const reconciler = new VisibilityReconciler({ toggle });
    await reconciler.setFilteringEnabled(true);
    // The probe hid alpha on its way to identifying beta.
    await reconciler.hide('toggle.alpha');
    reconciler.setMappings([mapping(alpha, 'toggle.alpha'), mapping(beta, 'toggle.beta')]);
    reconciler.setActionability(alpha, changed);
    reconciler.setActionability(beta, clean);
    await reconciler.waitForIdle();

    expect(toggle.mock.calls).toEqual([['toggle.alpha'], ['toggle.alpha'], ['toggle.beta']]);
    expect(reconciler.isHiddenByRepoFocus(alpha)).toBe(false);
    expect(reconciler.isHiddenByRepoFocus(beta)).toBe(true);
  });

  it('restores what the probe hid when filtering is not enabled', async () => {
    const alpha = repository('alpha');
    const toggle = vi.fn(async () => {});
    const reconciler = new VisibilityReconciler({ toggle });

    await reconciler.hide('toggle.alpha');
    reconciler.setMappings([mapping(alpha, 'toggle.alpha')]);
    await reconciler.waitForIdle();

    expect(toggle).toHaveBeenCalledTimes(2);
    expect(reconciler.isHiddenByRepoFocus(alpha)).toBe(false);
  });

  it('shows a probe-hidden repository until its actionability is known', async () => {
    const alpha = repository('alpha');
    const toggle = vi.fn(async () => {});
    const reconciler = new VisibilityReconciler({ toggle });
    await reconciler.setFilteringEnabled(true);

    await reconciler.hide('toggle.alpha');
    reconciler.setMappings([mapping(alpha, 'toggle.alpha')]);
    await reconciler.waitForIdle();

    expect(toggle).toHaveBeenCalledTimes(2);
    expect(reconciler.isHiddenByRepoFocus(alpha)).toBe(false);
  });

  it('restores commands the probe hid before any mapping is known', async () => {
    const toggle = vi.fn(async () => {});
    const reconciler = new VisibilityReconciler({ toggle });

    // A probe that dies part-way: two commands toggled, neither attributed.
    await reconciler.hide('toggle.one');
    await reconciler.hide('toggle.two');
    expect(reconciler.hiddenRepositoryCount).toBe(2);

    await reconciler.restoreOwned();

    expect(toggle.mock.calls).toEqual([
      ['toggle.one'],
      ['toggle.two'],
      ['toggle.one'],
      ['toggle.two'],
    ]);
    expect(reconciler.hiddenRepositoryCount).toBe(0);
    expect(reconciler.compatible).toBe(true);
  });

  it('keeps a hide recorded when the native command rejects, so recovery retries it', async () => {
    const failure = new Error('native command failed');
    const toggle = vi.fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValue(undefined);
    const reconciler = new VisibilityReconciler({ toggle });

    await expect(reconciler.hide('toggle.alpha')).rejects.toThrow(failure);
    expect(reconciler.hiddenRepositoryCount).toBe(1);

    await reconciler.restoreOwned();
    expect(reconciler.hiddenRepositoryCount).toBe(0);
  });

  it('drops ownership of a hidden repository that closes', async () => {
    const alpha = repository('alpha');
    const beta = repository('beta');
    const toggle = vi.fn(async () => {});
    const reconciler = new VisibilityReconciler({ toggle });
    await reconciler.setFilteringEnabled(true);
    reconciler.setMappings([mapping(alpha, 'toggle.alpha'), mapping(beta, 'toggle.beta')]);
    reconciler.setActionability(alpha, clean);
    reconciler.setActionability(beta, clean);
    await reconciler.waitForIdle();
    expect(reconciler.hiddenRepositoryCount).toBe(2);

    // VS Code unregisters toggle.alpha along with the repository's provider.
    reconciler.removeRepository(alpha);
    expect(reconciler.hiddenRepositoryCount).toBe(1);

    toggle.mockClear();
    await reconciler.restoreOwned();

    expect(toggle.mock.calls).toEqual([['toggle.beta']]);
    expect(reconciler.hiddenRepositoryCount).toBe(0);
    expect(reconciler.compatible).toBe(true);
  });

  it('reconciles a state update that arrives during an in-flight toggle', async () => {
    const alpha = repository('alpha');
    let releaseFirstToggle: (() => void) | undefined;
    const firstToggle = new Promise<void>(resolve => { releaseFirstToggle = resolve; });
    const toggle = vi.fn()
      .mockImplementationOnce(() => firstToggle)
      .mockResolvedValue(undefined);
    const reconciler = new VisibilityReconciler({ toggle });
    await reconciler.setFilteringEnabled(true);
    reconciler.setMappings([mapping(alpha, 'toggle.alpha')]);
    reconciler.setActionability(alpha, clean);
    await vi.waitFor(() => expect(toggle).toHaveBeenCalledTimes(1));

    reconciler.setActionability(alpha, changed);
    releaseFirstToggle?.();
    await reconciler.waitForIdle();

    expect(toggle).toHaveBeenCalledTimes(2);
    expect(reconciler.isHiddenByRepoFocus(alpha)).toBe(false);
  });

  it('restores every repository hidden by RepoFocus on shutdown', async () => {
    const alpha = repository('alpha');
    const beta = repository('beta');
    const toggle = vi.fn(async () => {});
    const reconciler = new VisibilityReconciler({ toggle });
    await reconciler.setFilteringEnabled(true);
    reconciler.setMappings([mapping(alpha, 'toggle.alpha'), mapping(beta, 'toggle.beta')]);
    reconciler.setActionability(alpha, clean);
    reconciler.setActionability(beta, clean);
    await reconciler.waitForIdle();

    await reconciler.shutdown();
    await reconciler.shutdown();

    expect(toggle.mock.calls).toEqual([
      ['toggle.alpha'],
      ['toggle.beta'],
      ['toggle.alpha'],
      ['toggle.beta'],
    ]);
    expect(reconciler.isHiddenByRepoFocus(alpha)).toBe(false);
    expect(reconciler.isHiddenByRepoFocus(beta)).toBe(false);
  });

  it('fails closed to filtering and restores owned hidden repositories after a toggle error', async () => {
    const alpha = repository('alpha');
    const beta = repository('beta');
    const failure = new Error('native command failed');
    const onError = vi.fn();
    const toggle = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(failure)
      .mockResolvedValue(undefined);
    const reconciler = new VisibilityReconciler({ toggle, onError });
    await reconciler.setFilteringEnabled(true);
    reconciler.setMappings([mapping(alpha, 'toggle.alpha'), mapping(beta, 'toggle.beta')]);
    reconciler.setActionability(alpha, clean);
    reconciler.setActionability(beta, clean);
    await reconciler.waitForIdle();

    expect(reconciler.compatible).toBe(false);
    expect(onError.mock.calls[0][0]).toBe(failure);
    expect(reconciler.isHiddenByRepoFocus(alpha)).toBe(false);
    expect(reconciler.isHiddenByRepoFocus(beta)).toBe(false);
    // beta's failed hide stays owned, so recovery reveals both.
    expect(toggle.mock.calls).toEqual([
      ['toggle.alpha'],
      ['toggle.beta'],
      ['toggle.alpha'],
      ['toggle.beta'],
    ]);
  });

  it('reports how many commands are stranded when reporting a failure', async () => {
    const alpha = repository('alpha');
    const onError = vi.fn();
    const toggle = vi.fn(async () => {});
    const reconciler = new VisibilityReconciler({ toggle, onError });
    await reconciler.setFilteringEnabled(true);
    reconciler.setMappings([mapping(alpha, 'toggle.alpha')]);
    reconciler.setActionability(alpha, clean);
    await reconciler.waitForIdle();

    await reconciler.failCompatibility(new Error('mapping changed'));

    expect(onError.mock.calls[0][1]).toEqual({ strandedCommandCount: 1 });
  });

  it('restores owned repositories after an external compatibility failure', async () => {
    const alpha = repository('alpha');
    const toggle = vi.fn(async () => {});
    const reconciler = new VisibilityReconciler({ toggle });
    await reconciler.setFilteringEnabled(true);
    reconciler.setMappings([mapping(alpha, 'toggle.alpha')]);
    reconciler.setActionability(alpha, clean);
    await reconciler.waitForIdle();

    await reconciler.failCompatibility(new Error('mapping changed'));
    reconciler.setActionability(alpha, clean);
    await reconciler.waitForIdle();

    expect(reconciler.compatible).toBe(false);
    expect(toggle).toHaveBeenCalledTimes(2);
    expect(reconciler.isHiddenByRepoFocus(alpha)).toBe(false);
  });

  it('restores repositories while disabled and reconciles current state when re-enabled', async () => {
    const alpha = repository('alpha');
    const toggle = vi.fn(async () => {});
    const reconciler = new VisibilityReconciler({ toggle });
    await reconciler.setFilteringEnabled(true);
    reconciler.setMappings([mapping(alpha, 'toggle.alpha')]);
    reconciler.setActionability(alpha, clean);
    await reconciler.waitForIdle();

    await reconciler.setFilteringEnabled(false);
    reconciler.setActionability(alpha, clean);
    await reconciler.waitForIdle();
    expect(reconciler.enabled).toBe(false);
    expect(reconciler.isHiddenByRepoFocus(alpha)).toBe(false);

    await reconciler.setFilteringEnabled(true);
    await reconciler.waitForIdle();
    expect(reconciler.enabled).toBe(true);
    expect(reconciler.isHiddenByRepoFocus(alpha)).toBe(true);
    expect(toggle).toHaveBeenCalledTimes(3);
  });

  it('reports a restoration failure and retains the repository for a later recovery attempt', async () => {
    const alpha = repository('alpha');
    const recoveryFailure = new Error('restore failed');
    const onError = vi.fn();
    const toggle = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(recoveryFailure)
      .mockRejectedValueOnce(recoveryFailure)
      .mockResolvedValueOnce(undefined);
    const reconciler = new VisibilityReconciler({ toggle, onError });
    await reconciler.setFilteringEnabled(true);
    reconciler.setMappings([mapping(alpha, 'toggle.alpha')]);
    reconciler.setActionability(alpha, clean);
    await reconciler.waitForIdle();

    await reconciler.setFilteringEnabled(false);
    expect(onError).toHaveBeenCalledTimes(2);
    expect(reconciler.isHiddenByRepoFocus(alpha)).toBe(true);

    await reconciler.setFilteringEnabled(false);
    expect(reconciler.isHiddenByRepoFocus(alpha)).toBe(false);
  });
});
