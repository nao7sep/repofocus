import type { GitRepository } from './gitApi';
import type { VisibilityMapping } from './visibilityCommandResolver';

export class VisibilityProbeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'VisibilityProbeError';
  }
}

export class VisibilityProbeInterruptedError extends Error {
  constructor() {
    super('Repository topology changed during native visibility mapping.');
    this.name = 'VisibilityProbeInterruptedError';
  }
}

export class VisibilityProbeLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VisibilityProbeLimitError';
  }
}

export interface VisibilityProbeLedger {
  hide(command: string): Promise<void>;
  reveal(command: string): Promise<void>;
}

export interface VisibilityProbeTimings {
  readonly selectionTimeoutMilliseconds?: number;
  readonly totalTimeoutMilliseconds?: number;
  readonly isCurrent?: () => boolean;
}

export const DEFAULT_SELECTION_TIMEOUT_MILLISECONDS = 1_000;
export function defaultTotalProbeTimeoutMilliseconds(platform = process.platform): number {
  return platform === 'win32' ? 120_000 : 60_000;
}
export const DEFAULT_TOTAL_PROBE_TIMEOUT_MILLISECONDS = defaultTotalProbeTimeoutMilliseconds();

function selectedRepository(repositories: readonly GitRepository[]): GitRepository | undefined {
  const selected = repositories.filter(repository => repository.ui.selected);
  return selected.length === 1 ? selected[0] : undefined;
}

async function waitForSelectedRepository(
  repositories: readonly GitRepository[],
  timeoutMilliseconds: number,
  assertCurrent: () => void,
  previousKey?: string,
): Promise<GitRepository | undefined> {
  const deadline = Date.now() + timeoutMilliseconds;
  for (;;) {
    assertCurrent();
    const selected = selectedRepository(repositories);
    if (selected && (previousKey === undefined || selected.rootUri.toString() !== previousKey)) {
      return selected;
    }
    if (Date.now() >= deadline) return undefined;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

/**
 * Maps opaque visibility commands to Git repositories in linear work without
 * assuming that the Git API and SCM command registry use the same order.
 *
 * First, all commands except one are hidden, which identifies the sole visible
 * repository. Then one unknown command is revealed at a time and the previously
 * identified repository is hidden, leaving exactly one repository visible again.
 * This reconstructs any permutation in 3N - 3 toggles rather than N squared.
 */
export async function mapVisibilityCommandsInOrder(
  repositories: readonly GitRepository[],
  candidateCommands: readonly string[],
  ledger: VisibilityProbeLedger,
  timings: VisibilityProbeTimings = {},
): Promise<readonly VisibilityMapping[]> {
  if (repositories.length !== candidateCommands.length || repositories.length === 0) {
    throw new VisibilityProbeError(
      'Every Git repository must have exactly one native visibility command.',
    );
  }

  const selectionTimeoutMilliseconds = timings.selectionTimeoutMilliseconds
    ?? DEFAULT_SELECTION_TIMEOUT_MILLISECONDS;
  const totalTimeoutMilliseconds = timings.totalTimeoutMilliseconds
    ?? DEFAULT_TOTAL_PROBE_TIMEOUT_MILLISECONDS;
  if (!Number.isSafeInteger(selectionTimeoutMilliseconds) || selectionTimeoutMilliseconds < 1) {
    throw new Error('Selection timeout must be a positive safe integer.');
  }
  if (!Number.isSafeInteger(totalTimeoutMilliseconds) || totalTimeoutMilliseconds < 1) {
    throw new Error('Visibility mapping timeout must be a positive safe integer.');
  }

  const deadline = Date.now() + totalTimeoutMilliseconds;
  const assertCurrent = (): void => {
    if (timings.isCurrent?.() === false) throw new VisibilityProbeInterruptedError();
    if (Date.now() >= deadline) {
      throw new VisibilityProbeLimitError(
        `Native visibility mapping did not finish within ${totalTimeoutMilliseconds} milliseconds.`,
      );
    }
  };
  const mappings = new Array<VisibilityMapping>(repositories.length);
  for (const command of candidateCommands.slice(0, -1)) {
    assertCurrent();
    await ledger.hide(command);
    assertCurrent();
  }

  let current = await waitForSelectedRepository(
    repositories,
    Math.min(selectionTimeoutMilliseconds, Math.max(1, deadline - Date.now())),
    assertCurrent,
  );
  if (!current) throw new VisibilityProbeError('Native repository focus did not settle.');

  const seenRepositories = new Set([current.rootUri.toString()]);
  let currentCommand = candidateCommands[candidateCommands.length - 1];
  mappings[candidateCommands.length - 1] = { repository: current, command: currentCommand };

  for (let index = candidateCommands.length - 2; index >= 0; index -= 1) {
    const command = candidateCommands[index];
    await ledger.reveal(command);
    assertCurrent();

    const currentKey = current.rootUri.toString();
    await ledger.hide(currentCommand);
    assertCurrent();
    const next = await waitForSelectedRepository(
      repositories,
      Math.min(selectionTimeoutMilliseconds, Math.max(1, deadline - Date.now())),
      assertCurrent,
      currentKey,
    );
    if (!next) {
      await ledger.reveal(currentCommand);
      throw new VisibilityProbeError(
        'Native repository focus did not transfer to the sole visible repository.',
      );
    }
    const nextKey = next.rootUri.toString();
    if (seenRepositories.has(nextKey)) {
      await ledger.reveal(currentCommand);
      throw new VisibilityProbeError('Native visibility mapping selected a repository twice.');
    }
    seenRepositories.add(nextKey);
    mappings[index] = { repository: next, command };
    current = next;
    currentCommand = command;
  }

  return mappings;
}
