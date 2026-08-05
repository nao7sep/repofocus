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
    reconciler.replaceMappings([mapping(alpha, 'toggle.alpha')]);
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
    reconciler.replaceMappings([mapping(alpha, 'toggle.alpha'), mapping(beta, 'toggle.beta')]);
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
    reconciler.replaceMappings([mapping(alpha, 'toggle.alpha')]);
    reconciler.setActionability(alpha, clean);
    reconciler.setActionability(alpha, clean);
    await reconciler.waitForIdle();
    reconciler.setActionability(alpha, clean);
    await reconciler.waitForIdle();

    expect(toggle).toHaveBeenCalledTimes(1);
  });

  it('reconciles directly from a verified partially hidden state', async () => {
    const alpha = repository('alpha');
    const beta = repository('beta');
    const toggle = vi.fn(async () => {});
    const reconciler = new VisibilityReconciler({ toggle });
    reconciler.adoptVisibility(
      [mapping(alpha, 'toggle.alpha'), mapping(beta, 'toggle.beta')],
      [alpha],
    );
    reconciler.setActionability(alpha, changed);
    reconciler.setActionability(beta, clean);
    await reconciler.waitForIdle();

    expect(toggle.mock.calls).toEqual([['toggle.alpha'], ['toggle.beta']]);
    expect(reconciler.isHiddenByRepoFocus(alpha)).toBe(false);
    expect(reconciler.isHiddenByRepoFocus(beta)).toBe(true);
  });

  it('reconciles a state update that arrives during an in-flight toggle', async () => {
    const alpha = repository('alpha');
    let releaseFirstToggle: (() => void) | undefined;
    const firstToggle = new Promise<void>(resolve => { releaseFirstToggle = resolve; });
    const toggle = vi.fn()
      .mockImplementationOnce(() => firstToggle)
      .mockResolvedValue(undefined);
    const reconciler = new VisibilityReconciler({ toggle });
    reconciler.replaceMappings([mapping(alpha, 'toggle.alpha')]);
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
    reconciler.replaceMappings([mapping(alpha, 'toggle.alpha'), mapping(beta, 'toggle.beta')]);
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
    reconciler.replaceMappings([mapping(alpha, 'toggle.alpha'), mapping(beta, 'toggle.beta')]);
    reconciler.setActionability(alpha, clean);
    reconciler.setActionability(beta, clean);
    await reconciler.waitForIdle();

    expect(reconciler.compatible).toBe(false);
    expect(onError).toHaveBeenCalledWith(failure);
    expect(reconciler.isHiddenByRepoFocus(alpha)).toBe(false);
    expect(reconciler.isHiddenByRepoFocus(beta)).toBe(false);
    expect(toggle.mock.calls).toEqual([
      ['toggle.alpha'],
      ['toggle.beta'],
      ['toggle.alpha'],
    ]);
  });

  it('restores owned repositories after an external compatibility failure', async () => {
    const alpha = repository('alpha');
    const toggle = vi.fn(async () => {});
    const reconciler = new VisibilityReconciler({ toggle });
    reconciler.replaceMappings([mapping(alpha, 'toggle.alpha')]);
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
    reconciler.replaceMappings([mapping(alpha, 'toggle.alpha')]);
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
      .mockResolvedValueOnce(undefined);
    const reconciler = new VisibilityReconciler({ toggle, onError });
    reconciler.replaceMappings([mapping(alpha, 'toggle.alpha')]);
    reconciler.setActionability(alpha, clean);
    await reconciler.waitForIdle();

    await reconciler.showAll();
    expect(onError).toHaveBeenCalledOnce();
    expect(reconciler.isHiddenByRepoFocus(alpha)).toBe(true);

    await reconciler.showAll();
    expect(reconciler.isHiddenByRepoFocus(alpha)).toBe(false);
  });
});
