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

export interface NativeVisibilityResetterOptions extends NativeVisibilityResetOptions {
  /** Another window, or the user, moved this window's selection mode away from multiple. */
  readonly onForeignDeparture: () => void;
  /**
   * Another window, or the user, returned this window's selection mode to
   * multiple, which VS Code answers by showing every repository.
   */
  readonly onForeignReset: () => void;
}

/**
 * Owns this window's selection-mode transitions. It coalesces automatic and
 * user-requested resets into one transition, and reports every selection-mode
 * transition it did not make: VS Code applies the user setting in every open
 * window, so another window's reset arrives here as a departure from multiple
 * and a return to it.
 */
export class NativeVisibilityResetter implements DisposableLike {
  private active: Promise<void> | undefined;
  private observedMode: string;
  private readonly subscription: DisposableLike;

  constructor(private readonly options: NativeVisibilityResetterOptions) {
    this.observedMode = options.getSelectionMode();
    this.subscription = options.onDidChangeSelectionMode(() => this.observeSelectionMode());
  }

  dispose(): void {
    this.subscription.dispose();
  }

  reset(): Promise<void> {
    if (this.active) return this.active;
    // Claimed before the first command starts, so every transition it causes
    // is observed as this window's own.
    const tracked = Promise.resolve()
      .then(() => resetNativeRepositoryVisibility(this.options))
      .finally(() => {
        if (this.active === tracked) this.active = undefined;
      });
    this.active = tracked;
    return tracked;
  }

  private observeSelectionMode(): void {
    const previous = this.observedMode;
    const mode = this.options.getSelectionMode();
    this.observedMode = mode;
    // This listener is registered before a reset's own transition listener, so
    // the reset is still active when its final transition is observed.
    if (this.active || mode === previous) return;
    if (mode === 'multiple') this.options.onForeignReset();
    else if (previous === 'multiple') this.options.onForeignDeparture();
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
      // VS Code writes this mode to the user settings, or to a workspace's
      // settings file when that workspace sets scm.repositories.selectionMode
      // itself. The developer accepted that write: VS Code offers no
      // setting-free way to reach a known all-visible state.
      options.executeCommand(selectionModeCommands[mode]).then(check, finish);
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    subscription?.dispose();
  }
}
