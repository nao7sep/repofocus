import type { RepositoryActionability } from './actionability';
import type { GitRepository } from './gitApi';
import { waitForSelectedRepository, VisibilityProbeInterruptedError, VisibilityProbeError } from './visibilityBaseline';
import type { RepositoryIdentity, VisibilityMapping } from './visibilityCommandResolver';

export type ToggleVisibility = (command: string) => Promise<void>;
export interface VisibilityFailure { readonly strandedCommandCount: number }
export interface VisibilityReconcilerOptions {
  readonly toggle: ToggleVisibility;
  readonly resetToAllVisible?: () => Promise<void>;
  readonly onError?: (error: Error, failure: VisibilityFailure) => void;
}

/** Native mutations run only inside the coordinator's serialized application.
 * The hide ledger describes that batch, never the user's current visibility.
 * Verified provider identities survive visibility resets; uncertain probes do not.
 */
export class VisibilityReconciler {
  private readonly actionability = new Map<string, RepositoryActionability>();
  private readonly mappings = new Map<string, VisibilityMapping>();
  private readonly hiddenCommands = new Set<string>();
  private state: 'active' | 'failed' | 'disposed' = 'active';
  private filteringEnabled = false;
  private pendingToggles = 0;
  private recovery: Promise<boolean> | undefined;
  private onDesiredChange: (() => void) | undefined;

  constructor(private readonly options: VisibilityReconcilerOptions) {}
  get compatible(): boolean { return this.state === 'active'; }
  get enabled(): boolean { return this.compatible && this.filteringEnabled; }
  get hiddenRepositoryCount(): number { return this.hiddenCommands.size; }
  get toggling(): boolean { return this.pendingToggles > 0; }

  onDidChangeDesiredVisibility(listener: () => void): void { this.onDesiredChange = listener; }
  setActionability(repository: RepositoryIdentity, value: RepositoryActionability): void {
    if (!this.compatible) return;
    const key = repository.rootUri.toString();
    const previous = this.actionability.get(key);
    this.actionability.set(key, value);
    if (previous?.actionable !== value.actionable) this.onDesiredChange?.();
  }
  setMappings(mappings: readonly VisibilityMapping[]): void {
    this.mappings.clear();
    for (const mapping of mappings) this.mappings.set(mapping.repository.rootUri.toString(), mapping);
  }
  hasMappings(repositories: readonly GitRepository[], commands: readonly string[]): boolean {
    const available = new Set(commands);
    return repositories.every(repository => {
      const mapping = this.mappings.get(repository.rootUri.toString());
      return mapping?.repository === repository && available.has(mapping.command);
    });
  }
  removeRepository(repository: RepositoryIdentity): void {
    const key = repository.rootUri.toString();
    const mapping = this.mappings.get(key);
    if (mapping) this.hiddenCommands.delete(mapping.command);
    this.mappings.delete(key);
    this.actionability.delete(key);
  }
  acceptAllVisible(): void { this.hiddenCommands.clear(); }
  isHiddenByRepoFocus(repository: RepositoryIdentity): boolean {
    const mapping = this.mappings.get(repository.rootUri.toString());
    return mapping !== undefined && this.hiddenCommands.has(mapping.command);
  }
  async hide(command: string): Promise<void> {
    this.hiddenCommands.add(command);
    await this.toggle(command);
  }
  async reveal(command: string): Promise<void> {
    await this.toggle(command);
    this.hiddenCommands.delete(command);
  }
  setFilteringEnabled(enabled: boolean): void { this.filteringEnabled = enabled; }

  /** Called only after reset/discovery established this batch's visibility. */
  async apply(
    repositories: readonly GitRepository[],
    selected: GitRepository | undefined,
    isCurrent: () => boolean,
    selectionTimeoutMilliseconds = 10_000,
  ): Promise<void> {
    const assertCurrent = (): void => {
      if (!isCurrent() || !this.compatible) throw new VisibilityProbeInterruptedError();
    };
    const visible = repositories.filter(repository => !this.enabled
      || this.actionability.get(repository.rootUri.toString())?.actionable !== false);
    selected = selected && repositories.find(repository => repository.rootUri.toString() === selected!.rootUri.toString());
    if (selected && visible.includes(selected) && !selected.ui.selected) {
      // Isolate the saved target to restore native selection without relying on
      // a command that changes a different notion of "active provider".
      const target = this.mappings.get(selected.rootUri.toString())!;
      assertCurrent();
      if (this.hiddenCommands.has(target.command)) await this.reveal(target.command);
      for (const repository of repositories) {
        assertCurrent();
        const mapping = this.mappings.get(repository.rootUri.toString())!;
        if (repository !== selected && !this.hiddenCommands.has(mapping.command)) await this.hide(mapping.command);
      }
      if (!await waitForSelectedRepository([selected], selectionTimeoutMilliseconds, assertCurrent)) {
        throw new VisibilityProbeError('Native repository selection could not be restored.');
      }
    }
    // Reveal first: restoring selection must not pass through an all-hidden set.
    for (const repository of visible) {
      assertCurrent();
      const mapping = this.mappings.get(repository.rootUri.toString())!;
      if (this.hiddenCommands.has(mapping.command)) await this.reveal(mapping.command);
    }
    const desired = new Set(visible);
    for (const repository of repositories) {
      assertCurrent();
      const mapping = this.mappings.get(repository.rootUri.toString())!;
      if (!desired.has(repository) && !this.hiddenCommands.has(mapping.command)) await this.hide(mapping.command);
    }
    assertCurrent();
  }

  failAllVisibleReset(error: unknown): void { this.fail(error); }
  failCompatibility(error: unknown): void { this.fail(error); }
  async restoreOwned(): Promise<void> { await this.resetAfterFailure(); }
  dispose(): void { this.state = 'disposed'; this.onDesiredChange = undefined; }

  private fail(error: unknown): void {
    if (!this.compatible) return;
    this.state = 'failed';
    this.options.onError?.(error instanceof Error ? error : new Error(String(error)), {
      strandedCommandCount: this.hiddenCommands.size,
    });
  }
  private async toggle(command: string): Promise<void> {
    this.pendingToggles += 1;
    try {
      await this.options.toggle(command);
    } catch (error) {
      this.fail(error);
      await this.resetAfterFailure();
      throw error;
    } finally { this.pendingToggles -= 1; }
  }
  private resetAfterFailure(): Promise<boolean> {
    if (this.state === 'disposed') return Promise.resolve(false);
    this.recovery ??= this.attemptReset().then(success => {
      if (!success) this.recovery = undefined;
      return success;
    });
    return this.recovery;
  }
  private async attemptReset(): Promise<boolean> {
    if (!this.options.resetToAllVisible) return false;
    try {
      await this.options.resetToAllVisible();
      this.acceptAllVisible();
      return true;
    } catch (error) {
      if (this.state !== 'disposed') this.options.onError?.(
        new Error('Failed to establish an all-visible baseline after a native visibility failure.', { cause: error }),
        { strandedCommandCount: this.hiddenCommands.size },
      );
      return false;
    }
  }
}
