import type { DisposableLike, EventLike } from './gitApi';
import { selectionModeCommands } from './visibilityCommandResolver';

export type RepositorySelectionMode = 'multiple' | 'single';

export interface NativeVisibilityResetOptions {
  readonly executeCommand: (command: string) => Promise<void>;
  readonly getSelectionMode: () => string;
  readonly onDidChangeSelectionMode: EventLike<void>;
  readonly timeoutMilliseconds?: number;
}

/**
 * Reveals every native SCM repository by passing through single selection and
 * back to multiple. VS Code exposes no public all-visible operation, while its
 * internal multiple-mode transition deterministically performs that reset.
 */
export async function resetNativeRepositoryVisibility(
  options: NativeVisibilityResetOptions,
): Promise<void> {
  await setSelectionMode(options, 'single');
  await setSelectionMode(options, 'multiple');
}

async function setSelectionMode(
  options: NativeVisibilityResetOptions,
  mode: RepositorySelectionMode,
): Promise<void> {
  const timeoutMilliseconds = options.timeoutMilliseconds ?? 5_000;
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
