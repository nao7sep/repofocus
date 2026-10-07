import type { DisposableLike, EventLike } from './gitApi';
import { NativeVisibilityCommandTimeoutError } from './nativeVisibilityCommandExecutor';
import { selectionModeCommands } from './visibilityCommandResolver';

export type RepositorySelectionMode = 'multiple' | 'single';

const defaultTimeoutMilliseconds = 60_000;

export interface NativeVisibilityResetOptions {
  readonly executeCommand: (command: string) => Promise<void>;
  readonly getSelectionMode: () => string;
  readonly onDidChangeSelectionMode: EventLike<void>;
  /** Joins the existing executor's raw command after its shorter caller timeout. */
  readonly waitForCommandSettlement?: (timeoutMilliseconds: number, signal?: AbortSignal) => Promise<void>;
  readonly signal?: AbortSignal;
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
  private readonly lifetime = new AbortController();

  constructor(private readonly options: NativeVisibilityResetterOptions) {
    this.observedMode = options.getSelectionMode();
    this.subscription = options.onDidChangeSelectionMode(() => this.observeSelectionMode());
  }

  dispose(): void {
    this.lifetime.abort();
    this.subscription.dispose();
  }

  reset(): Promise<void> {
    if (this.lifetime.signal.aborted) return Promise.reject(disposedError());
    if (this.active) return this.active;
    // Claimed before the first command starts, so every transition it causes
    // is observed as this window's own.
    const tracked = Promise.resolve()
      .then(() => resetNativeRepositoryVisibility({ ...this.options, signal: this.lifetime.signal }))
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
  await setSelectionMode(options, 'single', deadline);
  await setSelectionMode(options, 'multiple', deadline);
}

function remainingTime(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

function disposedError(): Error {
  return new Error('Native visibility reset was disposed.');
}

async function setSelectionMode(
  options: NativeVisibilityResetOptions,
  mode: RepositorySelectionMode,
  deadline: number,
): Promise<void> {
  if (options.signal?.aborted) throw disposedError();
  const timeoutMilliseconds = remainingTime(deadline);
  if (timeoutMilliseconds === 0) throw modeTimeout(mode, timeoutMilliseconds);
  let subscription: DisposableLike | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;

  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let commandComplete = false;
      const finish = (error?: unknown): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        subscription?.dispose();
        if (error === undefined) resolve();
        else reject(error);
      };
      const check = (): void => {
        if (!settled && commandComplete && options.getSelectionMode() === mode) finish();
      };

      subscription = options.onDidChangeSelectionMode(check);
      abort = () => finish(disposedError());
      options.signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => finish(modeTimeout(mode, timeoutMilliseconds)), timeoutMilliseconds);
      // VS Code writes this mode to the user settings, or to a workspace's
      // settings file when that workspace sets scm.repositories.selectionMode
      // itself. The developer accepted that write: VS Code offers no
      // setting-free way to reach a known all-visible state.
      const completed = (): void => {
        commandComplete = true;
        check();
      };
      options.executeCommand(selectionModeCommands[mode]).then(completed, error => {
        if (settled) return;
        // The command slot survives the executor's shorter deadline. Keep this
        // reset pending inside its own budget until that slot and the effective
        // mode settle; an RPC reply alone says nothing about settings durability.
        const wait = options.waitForCommandSettlement;
        const remaining = remainingTime(deadline);
        if (error instanceof NativeVisibilityCommandTimeoutError && wait && remaining > 0) {
          wait(remaining, options.signal).then(completed, finish);
        } else {
          finish(error);
        }
      });
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    subscription?.dispose();
    if (abort) options.signal?.removeEventListener('abort', abort);
  }
}

function modeTimeout(mode: RepositorySelectionMode, milliseconds: number): Error {
  return new Error(
    `VS Code did not settle repository selection mode "${mode}" within ${milliseconds} milliseconds.`,
  );
}
