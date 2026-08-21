export const NATIVE_VISIBILITY_COMMAND_TIMEOUT_MILLISECONDS = 10_000;

export class NativeVisibilityCommandTimeoutError extends Error {
  constructor(command: string, milliseconds: number) {
    super(`Native visibility command "${command}" did not finish within ${milliseconds} milliseconds.`);
    this.name = 'NativeVisibilityCommandTimeoutError';
  }
}

export class NativeVisibilityCommandBusyError extends Error {
  constructor(command: string) {
    super(`Native visibility command "${command}" was not started because an earlier command is still running.`);
    this.name = 'NativeVisibilityCommandBusyError';
  }
}

export class NativeVisibilityCommandIdleTimeoutError extends Error {
  constructor(milliseconds: number) {
    super(`The active native visibility command did not settle within ${milliseconds} milliseconds.`);
    this.name = 'NativeVisibilityCommandIdleTimeoutError';
  }
}

export interface NativeVisibilityCommandExecutorOptions {
  readonly execute: (command: string) => Promise<void>;
  readonly timeoutMilliseconds?: number;
}

/**
 * Bounds and single-flights the unsupported native command seam. A timed-out
 * VS Code command cannot be cancelled, so it retains the one execution slot
 * until its underlying promise settles; recovery fails fast instead of piling
 * more toggles onto an operation whose outcome is unknown.
 */
export class NativeVisibilityCommandExecutor {
  private active: Promise<void> | undefined;
  private disposed = false;
  private readonly timeoutMilliseconds: number;

  constructor(private readonly options: NativeVisibilityCommandExecutorOptions) {
    const timeout = options.timeoutMilliseconds ?? NATIVE_VISIBILITY_COMMAND_TIMEOUT_MILLISECONDS;
    if (!Number.isSafeInteger(timeout) || timeout < 1) {
      throw new Error('Native visibility command timeout must be a positive safe integer.');
    }
    this.timeoutMilliseconds = timeout;
  }

  async execute(command: string): Promise<void> {
    if (this.disposed) throw new Error('Native visibility command executor is disposed.');
    if (this.active) throw new NativeVisibilityCommandBusyError(command);

    const operation = Promise.resolve().then(() => this.options.execute(command));
    this.active = operation;
    void operation.then(
      () => { if (this.active === operation) this.active = undefined; },
      () => { if (this.active === operation) this.active = undefined; },
    );

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(
            new NativeVisibilityCommandTimeoutError(command, this.timeoutMilliseconds),
          ), this.timeoutMilliseconds);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * Waits for an already-started native command to settle without starting or
   * retrying anything. Recovery uses this after a caller-facing timeout so it
   * can establish a known baseline only after the ambiguous operation ends.
   */
  async waitForIdle(timeoutMilliseconds: number): Promise<void> {
    if (!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds < 1) {
      throw new Error('Native visibility idle timeout must be a positive safe integer.');
    }
    const active = this.active;
    if (!active) return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        active.catch(() => undefined),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(
            new NativeVisibilityCommandIdleTimeoutError(timeoutMilliseconds),
          ), timeoutMilliseconds);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  dispose(): void {
    this.disposed = true;
  }
}
