import type { DisposableLike, EventLike } from './gitApi';
import { selectionModeCommands } from './visibilityCommandResolver';

export type RepositorySelectionMode = 'multiple' | 'single';

const defaultTimeoutMilliseconds = 60_000;

export interface NativeVisibilityResetOptions {
  readonly executeCommand: (command: string) => Promise<void>;
  readonly getSelectionMode: () => string;
  readonly onDidChangeSelectionMode: EventLike<void>;
  readonly timeoutMilliseconds?: number;
}

/** Coalesce automatic and user-requested reset attempts into one transition. */
export class NativeVisibilityResetter {
  private active: Promise<void> | undefined;

  constructor(private readonly options: NativeVisibilityResetOptions) {}

  get running(): boolean {
    return this.active !== undefined;
  }

  reset(): Promise<void> {
    if (this.active) return this.active;
    const operation = resetNativeRepositoryVisibility(this.options);
    const tracked = operation.finally(() => {
      if (this.active === tracked) this.active = undefined;
    });
    this.active = tracked;
    return tracked;
  }
}

/**
 * Reveals every native SCM repository by passing through single selection and
 * back to multiple. VS Code exposes no public all-visible operation, while its
 * internal multiple-mode transition deterministically performs that reset.
 */
export async function resetNativeRepositoryVisibility(
  options: NativeVisibilityResetOptions,
): Promise<void> {
  const timeoutMilliseconds = options.timeoutMilliseconds ?? defaultTimeoutMilliseconds;
  if (!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds < 1) {
    throw new Error('Native visibility reset timeout must be a positive safe integer.');
  }
  const deadline = Date.now() + timeoutMilliseconds;
  await setSelectionMode(options, 'single', remainingTime(deadline));
  await setSelectionMode(options, 'multiple', remainingTime(deadline));
}

function remainingTime(deadline: number): number {
  return Math.max(1, deadline - Date.now());
}

async function setSelectionMode(
  options: NativeVisibilityResetOptions,
  mode: RepositorySelectionMode,
  timeoutMilliseconds: number,
): Promise<void> {
  let subscription: DisposableLike | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        subscription?.dispose();
        if (error === undefined) resolve();
        else reject(error);
      };
      const check = (): void => {
        if (options.getSelectionMode() === mode) finish();
      };

      subscription = options.onDidChangeSelectionMode(check);
      timer = setTimeout(() => finish(new Error(
        `VS Code did not enter repository selection mode "${mode}" within `
        + `${timeoutMilliseconds} milliseconds.`,
      )), timeoutMilliseconds);
      options.executeCommand(selectionModeCommands[mode]).then(check, finish);
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    subscription?.dispose();
  }
}
