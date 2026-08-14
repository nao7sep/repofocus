import type { DisposableLike } from './gitApi';

export interface RemoteFetchTarget {
  readonly key: string;
  /**
   * Whether this exact target still exists. The key alone cannot answer it: a
   * repository can close and reopen at the same URI while its fetch is in
   * flight, and the replacement is a different object wearing the same key.
   * Callers that can distinguish the two supply this; the rest fall back to key
   * membership.
   */
  isLive?(): boolean;
  fetch(): Promise<void>;
}

export interface RemoteFetchSchedulerOptions {
  readonly getTargets: () => readonly RemoteFetchTarget[];
  readonly concurrency?: number;
  readonly onError?: (target: RemoteFetchTarget, error: unknown) => void;
  readonly onSuccess?: (target: RemoteFetchTarget) => void;
}

export class RemoteFetchScheduler implements DisposableLike {
  private intervalMilliseconds = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private run: Promise<void> | undefined;
  private requested = false;
  private disposed = false;
  private readonly concurrency: number;
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
      let next = 0;
      const worker = async (): Promise<void> => {
        while (!this.disposed) {
          const index = next;
          next += 1;
          const target = targets[index];
          if (!target) return;
          try {
            await target.fetch();
            // A dead target records nothing: its key may already name a
            // different repository, and attributing this result to that one
            // would be worse than having no result at all.
            if (this.disposed || !this.isLive(target)) continue;
            this.failures.delete(target.key);
            this.options.onSuccess?.(target);
          } catch (error) {
            if (this.disposed || !this.isLive(target)) continue;
            this.failures.set(target.key, target);
            this.options.onError?.(target, error);
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(this.concurrency, targets.length) }, worker));
    }
  }

  /**
   * Targets are a snapshot taken when a run starts. A repository can close, or
   * lose its last remote, while its fetch is still in flight; reporting that
   * completion would resurrect it in the caller's state.
   */
  private isLive(target: RemoteFetchTarget): boolean {
    if (target.isLive) return target.isLive();
    return this.options.getTargets().some(candidate => candidate.key === target.key);
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
