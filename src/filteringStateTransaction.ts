export interface FilteringStateTransactionOptions {
  readonly initialValue: boolean;
  readonly applyNative: (enabled: boolean) => PromiseLike<void>;
  readonly persist: (enabled: boolean) => PromiseLike<void>;
  readonly publishContext: (enabled: boolean) => PromiseLike<void>;
}

export class FilteringStateTransitionError extends Error {
  constructor(cause: unknown, readonly rollbackErrors: readonly unknown[]) {
    super(
      rollbackErrors.length === 0
        ? 'Filtering state change failed and was rolled back.'
        : `Filtering state change failed; ${rollbackErrors.length} rollback operation(s) also failed.`,
      { cause },
    );
    this.name = 'FilteringStateTransitionError';
  }
}

/**
 * Publishes one filtering value across native visibility, durable host state,
 * and the host context key. Transitions are serialized, and runtime state moves
 * only after all three projections agree.
 */
export class FilteringStateTransaction {
  private value: boolean;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly options: FilteringStateTransactionOptions) {
    this.value = options.initialValue;
  }

  get current(): boolean {
    return this.value;
  }

  toggle(): Promise<boolean> {
    return this.enqueue(() => this.transition(!this.value));
  }

  private enqueue(operation: () => Promise<boolean>): Promise<boolean> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async transition(enabled: boolean): Promise<boolean> {
    const previous = this.value;
    if (enabled === previous) return previous;

    try {
      await this.options.applyNative(enabled);
      await this.options.persist(enabled);
      await this.options.publishContext(enabled);
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      // A rejected host promise can still have crossed its process boundary.
      // Reassert every old projection rather than guessing which side applied.
      for (const rollback of [
        () => this.options.publishContext(previous),
        () => this.options.persist(previous),
        () => this.options.applyNative(previous),
      ]) {
        try {
          await rollback();
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      throw new FilteringStateTransitionError(error, rollbackErrors);
    }

    this.value = enabled;
    return enabled;
  }
}
