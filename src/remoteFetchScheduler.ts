import type { DisposableLike } from './gitApi';

export interface RemoteFetchTarget {
  readonly key: string;
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
  private readonly failures = new Set<string>();

  /**
   * The last attempt's outcome per target, owned here rather than in a parallel
   * map, so a target that disappears — fetching disabled, the last remote
   * removed, the repository closed — cannot leave behind a failure nothing can
   * clear. Membership is re-derived from the live target set on every read.
   */
  hasFailed(key: string): boolean {
    if (!this.failures.has(key)) return false;
    if (this.options.getTargets().some(target => target.key === key)) return true;
    this.failures.delete(key);
    return false;
  }

  get failureCount(): number {
    const live = new Set(this.options.getTargets().map(target => target.key));
    for (const key of [...this.failures]) if (!live.has(key)) this.failures.delete(key);
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
            this.failures.delete(target.key);
            if (!this.disposed) this.options.onSuccess?.(target);
          } catch (error) {
            this.failures.add(target.key);
            if (!this.disposed) this.options.onError?.(target, error);
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(this.concurrency, targets.length) }, worker));
    }
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
