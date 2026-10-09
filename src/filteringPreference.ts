import { waitForHostOperation } from './hostOperation';

export interface FilteringPreferenceOptions {
  readonly initialValue: boolean;
  /** Applies the live preference to native visibility; the reconciler reports its own failures. */
  readonly apply: () => PromiseLike<void>;
  readonly persist: (enabled: boolean) => PromiseLike<void>;
  readonly publishContext: (enabled: boolean) => PromiseLike<void>;
  readonly hostWriteTimeoutMilliseconds: number;
}

export interface FilteringToggleResult {
  readonly enabled: boolean;
  /** Set when the stored preference was not confirmed, so it may not survive a reload. */
  readonly saveError?: unknown;
  /** Set when the context key was not confirmed, so the Refresh button may not match. */
  readonly contextError?: unknown;
}

/** A stored value that is not a boolean reads as the default, enabled, and is rewritten only by a toggle. */
export function readStoredFilteringEnabled(stored: unknown): boolean {
  return typeof stored === 'boolean' ? stored : true;
}

/**
 * Writes the latest value of one host projection. At most one write is in
 * flight and the next waits for its real settlement, not the caller's
 * timeout, so a slow write can never land after a newer one.
 */
class LatestValueWriter {
  private latest = false;
  private confirmed: boolean | undefined;
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly write: (value: boolean) => PromiseLike<void>) {}

  request(value: boolean): Promise<void> {
    this.latest = value;
    const step = this.chain.then(async () => {
      const value = this.latest;
      if (value === this.confirmed) return;
      this.confirmed = undefined;
      await this.write(value);
      this.confirmed = value;
    });
    this.chain = step.catch(() => undefined);
    return step;
  }
}

/**
 * Owns the user's filtering preference, the single authority for whether
 * RepoFocus filters. Native visibility follows it through the reconciler; the
 * stored value and the context key are projections. A projection that fails
 * is reported and never compensated by reverting the preference, because a
 * host write that timed out may still land.
 */
export class FilteringPreference {
  private value: boolean;
  private readonly stored: LatestValueWriter;
  private readonly context: LatestValueWriter;

  constructor(private readonly options: FilteringPreferenceOptions) {
    this.value = options.initialValue;
    this.stored = new LatestValueWriter(options.persist);
    this.context = new LatestValueWriter(options.publishContext);
  }

  get current(): boolean {
    return this.value;
  }

  /** Flips the preference at once, so rapid toggles alternate from the latest value. */
  async toggle(): Promise<FilteringToggleResult> {
    const enabled = !this.value;
    this.value = enabled;
    const timeout = this.options.hostWriteTimeoutMilliseconds;
    const [applied, saved, published] = await Promise.allSettled([
      Promise.resolve().then(() => this.options.apply()),
      waitForHostOperation(this.stored.request(enabled), timeout, 'Filtering preference save'),
      waitForHostOperation(this.context.request(enabled), timeout, 'Filtering context update'),
    ]);
    if (applied.status === 'rejected') throw applied.reason;
    return {
      enabled,
      ...saved.status === 'rejected' ? { saveError: saved.reason } : {},
      ...published.status === 'rejected' ? { contextError: published.reason } : {},
    };
  }
}
