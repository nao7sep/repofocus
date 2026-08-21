import type { DisposableLike } from './gitApi';

export interface RemoteFetchTarget {
  readonly key: string;
  /**
   * Whether this target is still the same thing it was. The key cannot answer
   * it: a repository can close and reopen at the same URI while its fetch is in
   * flight, and the replacement is a different object wearing the same key.
   * Callers that can distinguish the two supply this; it narrows the
   * scheduler's own eligibility check rather than replacing it.
   */
  isLive?(): boolean;
  fetch(): Promise<void>;
}

/**
 * How long one target's fetch may run before the scheduler stops waiting on it.
 *
 * `git fetch` can hang indefinitely rather than fail: SSH sitting at a host-key
 * or passphrase prompt on a non-tty, or a host that accepts the TCP connection
 * and then never speaks. An unbounded await on that does more than delay one
 * repository — the worker never returns, so `drain` never resolves, so the
 * `finally` that reschedules never runs, and periodic auto-fetch stays dead for
 * the rest of the session with nothing logged and no badge to show it. Reloading
 * the window was the only cure, and nothing told the user to.
 *
 * The underlying fetch cannot be cancelled — the Git extension's `fetch()` takes
 * no cancellation token — so the bound abandons it rather than killing it: the
 * target records a failure, the run completes, and the next tick is scheduled.
 * Generous, because a first fetch of a large repository over a slow link is
 * legitimately slow; this exists to end a wedge, not to police slowness.
 */
export const FETCH_TIMEOUT_MILLISECONDS = 120_000;

export class FetchTimeoutError extends Error {
  constructor(milliseconds: number) {
    super(`Fetch did not finish within ${Math.round(milliseconds / 1000)} seconds.`);
    this.name = 'FetchTimeoutError';
  }
}

export interface RemoteFetchSchedulerOptions {
  readonly getTargets: () => readonly RemoteFetchTarget[];
  readonly concurrency?: number;
  /** Overridable so tests can prove the bound without waiting it out. */
  readonly fetchTimeoutMilliseconds?: number;
  readonly onError?: (target: RemoteFetchTarget, error: unknown) => void;
  readonly onSuccess?: (target: RemoteFetchTarget) => void;
  readonly onRunStart?: (targetCount: number) => void;
  readonly onRunComplete?: (result: RemoteFetchRunResult) => void;
}

export interface RemoteFetchRunResult {
  readonly targetCount: number;
  readonly successCount: number;
  readonly failureCount: number;
  readonly staleCount: number;
  readonly durationMilliseconds: number;
}

export class RemoteFetchScheduler implements DisposableLike {
  private intervalMilliseconds = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private run: Promise<void> | undefined;
  private requested = false;
  private disposed = false;
  private readonly concurrency: number;
  private readonly fetchTimeoutMilliseconds: number;
  /**
   * The last attempt's outcome, held against the target that produced it rather
   * than against its key alone. A key names a repository URI, and a repository
   * can close and reopen at that URI: keying by it would hand the replacement
   * its predecessor's failure. The stored target answers its own liveness
   * through the same rule that governs completions.
   */
  private readonly failures = new Map<string, RemoteFetchTarget>();

  hasFailed(key: string): boolean {
    const failed = this.failures.get(key);
    if (!failed) return false;
    if (this.isLive(failed)) return true;
    this.failures.delete(key);
    return false;
  }

  get failureCount(): number {
    for (const [key, failed] of [...this.failures]) {
      if (!this.isLive(failed)) this.failures.delete(key);
    }
    return this.failures.size;
  }

  constructor(private readonly options: RemoteFetchSchedulerOptions) {
    const concurrency = options.concurrency ?? 2;
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
      throw new Error('Fetch concurrency must be a positive safe integer.');
    }
    this.concurrency = concurrency;
    const timeout = options.fetchTimeoutMilliseconds ?? FETCH_TIMEOUT_MILLISECONDS;
    if (!Number.isSafeInteger(timeout) || timeout < 1) {
      throw new Error('Fetch timeout must be a positive safe integer.');
    }
    this.fetchTimeoutMilliseconds = timeout;
  }

  /**
   * Await a fetch, but never past the bound. The timer is cleared on both paths
   * so a completed fetch leaves nothing pending behind it.
   */
  private async fetchBounded(target: RemoteFetchTarget): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        target.fetch(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new FetchTimeoutError(this.fetchTimeoutMilliseconds)),
            this.fetchTimeoutMilliseconds,
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  setInterval(intervalMilliseconds: number): void {
    if (!Number.isSafeInteger(intervalMilliseconds) || intervalMilliseconds < 0) {
      throw new Error('Fetch interval must be a non-negative safe integer.');
    }
    this.intervalMilliseconds = intervalMilliseconds;
    this.reschedule();
  }

  refreshNow(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.requested = true;
    this.clearTimer();
    if (!this.run) {
      this.run = this.drain().finally(() => {
        this.run = undefined;
        this.reschedule();
      });
    }
    return this.run;
  }

  async waitForIdle(): Promise<void> {
    while (this.run) await this.run;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.requested = false;
    this.clearTimer();
  }

  private async drain(): Promise<void> {
    while (this.requested && !this.disposed) {
      this.requested = false;
      const targets = [...this.options.getTargets()];
      if (targets.length === 0) continue;
      const startedAt = Date.now();
      let successCount = 0;
      let failureCount = 0;
      let staleCount = 0;
      this.options.onRunStart?.(targets.length);
      let next = 0;
      const worker = async (): Promise<void> => {
        while (!this.disposed) {
          const index = next;
          next += 1;
          const target = targets[index];
          if (!target) return;
          try {
            await this.fetchBounded(target);
            // A dead target records nothing: its key may already name a
            // different repository, and attributing this result to that one
            // would be worse than having no result at all.
            if (this.disposed || !this.isLive(target)) {
              staleCount += 1;
              continue;
            }
            this.failures.delete(target.key);
            successCount += 1;
            this.options.onSuccess?.(target);
          } catch (error) {
            if (this.disposed || !this.isLive(target)) {
              staleCount += 1;
              continue;
            }
            this.failures.set(target.key, target);
            failureCount += 1;
            this.options.onError?.(target, error);
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(this.concurrency, targets.length) }, worker));
      if (!this.disposed) {
        this.options.onRunComplete?.({
          targetCount: targets.length,
          successCount,
          failureCount,
          staleCount,
          durationMilliseconds: Date.now() - startedAt,
        });
      }
    }
  }

  /**
   * Targets are a snapshot taken when a run starts. A repository can close, or
   * lose its last remote, while its fetch is still in flight; reporting that
   * completion would resurrect it in the caller's state.
   */
  /**
   * Liveness is eligibility *and* identity, composed here so a caller cannot
   * answer one and silently lose the other. The target set answers whether this
   * key is still worth fetching at all — its remotes, the policy — and the
   * target itself answers whether it is the same repository the key now names.
   */
  private isLive(target: RemoteFetchTarget): boolean {
    const current = this.options.getTargets().find(candidate => candidate.key === target.key);
    if (!current) return false;
    return target.isLive?.() ?? true;
  }

  private reschedule(): void {
    this.clearTimer();
    if (this.disposed || this.run || this.intervalMilliseconds === 0) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.refreshNow();
    }, this.intervalMilliseconds);
  }

  private clearTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
