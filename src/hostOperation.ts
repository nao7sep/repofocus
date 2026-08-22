export class HostOperationTimeoutError extends Error {
  constructor(operation: string, milliseconds: number) {
    super(`${operation} did not finish within ${milliseconds} milliseconds.`);
    this.name = 'HostOperationTimeoutError';
  }
}

/**
 * Wait for a non-cancellable host operation without pretending the underlying
 * work stopped when the caller-facing deadline expires.
 */
export async function waitForHostOperation<T>(
  operation: Promise<T>,
  timeoutMilliseconds: number,
  description: string,
): Promise<T> {
  if (!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds < 1) {
    throw new Error('Host operation timeout must be a positive safe integer.');
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(
          new HostOperationTimeoutError(description, timeoutMilliseconds),
        ), timeoutMilliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** A dependency activation is attempted once; a timeout never starts a rival activation. */
export class OneShotHostOperation<T> {
  private operation: Promise<T> | undefined;

  wait(
    start: () => PromiseLike<T>,
    timeoutMilliseconds: number,
    description: string,
  ): Promise<T> {
    this.operation ??= Promise.resolve().then(start);
    return waitForHostOperation(this.operation, timeoutMilliseconds, description);
  }
}

/**
 * Serializes repeatable host reads. A timed-out call retains the slot until it
 * really settles, so a retry can never overlap the operation whose result is unknown.
 */
export class NonOverlappingHostOperation<T> {
  private active: Promise<T> | undefined;

  wait(
    start: () => PromiseLike<T>,
    timeoutMilliseconds: number,
    description: string,
  ): Promise<T> {
    if (!this.active) {
      const operation = Promise.resolve().then(start);
      this.active = operation;
      void operation.then(
        () => { if (this.active === operation) this.active = undefined; },
        () => { if (this.active === operation) this.active = undefined; },
      );
    }
    return waitForHostOperation(this.active, timeoutMilliseconds, description);
  }
}
