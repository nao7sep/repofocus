import type { AlwaysShowPatterns } from './alwaysShow';
import type { AlwaysShowWorkerRequest, AlwaysShowWorkerResponse } from './alwaysShowWorkerProtocol';

export type AlwaysShowResult =
  | { readonly kind: 'pending' }
  | { readonly kind: 'matched'; readonly matches: boolean }
  | { readonly kind: 'failed'; readonly error: Error };

export interface AlwaysShowWorkerPort {
  postMessage(request: AlwaysShowWorkerRequest): void;
  on(event: 'message', listener: (response: AlwaysShowWorkerResponse) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'exit', listener: (code: number) => void): unknown;
  terminate(): Promise<number>;
  unref(): void;
}

interface MatchRecord {
  readonly path: string;
  readonly generation: number;
  result: AlwaysShowResult;
  changed: () => void;
}

class MatchingInterrupted extends Error {}
export class AlwaysShowTimeoutError extends Error {}

/**
 * Minimatch can spend extreme CPU time even with short patterns. One terminable
 * worker isolates compilation and matching from VS Code's shared extension host.
 * Each open repository owns one cached result per settings generation; Git
 * events update its callback, rather than adding another queued match.
 */
export class AlwaysShowMatcher {
  private generation = 0;
  private configuration: AlwaysShowPatterns = { patterns: [], patternCount: 0, valid: true };
  private readonly records = new Map<string, MatchRecord>();
  private readonly queued = new Set<string>();
  private worker: AlwaysShowWorkerPort | undefined;
  private response: { resolve(response: AlwaysShowWorkerResponse): void; reject(error: Error): void } | undefined;
  private stopping: Promise<void> = Promise.resolve();
  private terminationFailure: Error | undefined;
  private generationFailure: Error | undefined;
  private run: Promise<void> | undefined;
  private disposed = false;

  constructor(private readonly options: {
    readonly createWorker: () => AlwaysShowWorkerPort;
    readonly startupTimeoutMilliseconds?: number;
    readonly matchTimeoutMilliseconds?: number;
  }) {}

  configure(configuration: AlwaysShowPatterns): void {
    if (this.disposed) return;
    this.generation += 1;
    this.configuration = configuration;
    this.generationFailure = undefined;
    this.records.clear();
    this.queued.clear();
    void this.stopWorker();
  }

  evaluate(key: string, path: string, changed: () => void): AlwaysShowResult {
    if (this.disposed || this.configuration.patterns.length === 0) return { kind: 'matched', matches: false };
    const previous = this.records.get(key);
    if (previous?.path === path) {
      previous.changed = changed;
      return previous.result;
    }
    const record: MatchRecord = {
      path, generation: this.generation, changed,
      result: this.generationFailure
        ? { kind: 'failed', error: this.generationFailure }
        : { kind: 'pending' },
    };
    this.records.set(key, record);
    if (record.result.kind === 'pending') {
      this.queued.add(key);
      this.startDrain();
    }
    return record.result;
  }

  forget(key: string): void {
    this.records.delete(key);
    this.queued.delete(key);
  }

  async waitForIdle(): Promise<void> {
    while (this.run) await this.run;
    await this.stopping;
  }

  dispose(): void {
    this.disposed = true;
    this.records.clear();
    this.queued.clear();
    void this.stopWorker();
  }

  private startDrain(): void {
    if (this.run || this.disposed || this.queued.size === 0) return;
    this.run = this.drain().finally(() => {
      this.run = undefined;
      this.startDrain();
    });
  }

  private async drain(): Promise<void> {
    while (!this.disposed && this.queued.size > 0) {
      const key = this.queued.values().next().value!;
      this.queued.delete(key);
      const record = this.records.get(key)!;
      try {
        await this.ensureWorker(record.generation);
      } catch (error) {
        if (error instanceof MatchingInterrupted) continue;
        await this.stopWorker();
        if (record.generation !== this.generation || this.disposed) continue;
        this.generationFailure = this.asError(error);
        this.queued.clear();
        for (const pending of this.records.values()) {
          if (pending.result.kind === 'pending') this.publish(pending, { kind: 'failed', error: this.generationFailure });
        }
        continue;
      }
      if (record.generation !== this.generation || this.records.get(key) !== record || this.disposed) continue;
      let result: AlwaysShowResult;
      try {
        const response = await this.request(
          { kind: 'match', path: record.path },
          this.options.matchTimeoutMilliseconds ?? 1_000,
        );
        if (response.kind !== 'match') throw new Error('Unexpected always-show match response.');
        result = { kind: 'matched', matches: response.matches };
      } catch (error) {
        await this.stopWorker();
        if (error instanceof MatchingInterrupted) continue;
        result = { kind: 'failed', error: this.asError(error) };
      }
      if (record.generation === this.generation && this.records.get(key) === record && !this.disposed) {
        this.publish(record, result);
      }
    }
  }

  private publish(record: MatchRecord, result: AlwaysShowResult): void {
    record.result = result;
    record.changed();
  }

  private async ensureWorker(generation: number): Promise<void> {
    await this.stopping;
    if (generation !== this.generation || this.disposed) throw new MatchingInterrupted();
    if (this.terminationFailure) throw this.terminationFailure;
    if (this.worker) return;
    const worker = this.options.createWorker();
    this.worker = worker;
    worker.on('message', response => {
      if (this.worker !== worker) return;
      if (response.kind === 'failure') {
        const error = new Error(response.error.message);
        error.name = response.error.name;
        error.stack = response.error.stack;
        this.response?.reject(error);
      } else this.response?.resolve(response);
    });
    worker.on('error', error => {
      if (this.worker === worker) this.response?.reject(error);
    });
    worker.on('exit', code => {
      if (this.worker !== worker) return;
      this.worker = undefined;
      this.response?.reject(new Error(`Always-show worker exited with code ${code}.`));
    });
    worker.unref();
    const response = await this.request(
      { kind: 'configure', patterns: this.configuration.patterns },
      this.options.startupTimeoutMilliseconds ?? 5_000,
    );
    if (response.kind !== 'ready') throw new Error('Unexpected always-show configuration response.');
  }

  private request(request: AlwaysShowWorkerRequest, milliseconds: number): Promise<AlwaysShowWorkerResponse> {
    return new Promise((resolve, reject) => {
      const finish = (response?: AlwaysShowWorkerResponse, error?: Error): void => {
        clearTimeout(timer);
        this.response = undefined;
        if (error) reject(error);
        else resolve(response!);
      };
      const timer = setTimeout(() => finish(undefined,
        new AlwaysShowTimeoutError(`Always-show ${request.kind} did not settle within ${milliseconds} milliseconds.`)), milliseconds);
      this.response = { resolve: response => finish(response), reject: error => finish(undefined, error) };
      try {
        this.worker!.postMessage(request);
      } catch (error) {
        finish(undefined, this.asError(error));
      }
    });
  }

  private stopWorker(): Promise<void> {
    const worker = this.worker;
    if (!worker) return this.stopping;
    this.worker = undefined;
    this.response?.reject(new MatchingInterrupted());
    // A deadline is not termination. No replacement starts until this settles.
    this.stopping = worker.terminate().then(() => {}, error => {
      this.terminationFailure = this.asError(error);
    });
    return this.stopping;
  }

  private asError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
  }
}
