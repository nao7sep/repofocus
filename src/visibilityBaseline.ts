import type { GitRepository } from './gitApi';
import type { RepositoryIdentity, VisibilityMapping } from './visibilityCommandResolver';

export class VisibilityBaselineError extends Error {
  constructor(
    message: string,
    readonly recoveredToAllVisible: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'VisibilityBaselineError';
  }
}

export interface VisibilityBaseline {
  readonly mappings: readonly VisibilityMapping[];
  readonly hiddenRepositories: readonly RepositoryIdentity[];
}

function selectedRepository(repositories: readonly GitRepository[]): GitRepository | undefined {
  const selected = repositories.filter(repository => repository.ui.selected);
  return selected.length === 1 ? selected[0] : undefined;
}

async function waitForSelectedRepository(
  repositories: readonly GitRepository[],
  timeoutMilliseconds: number,
): Promise<GitRepository> {
  const deadline = Date.now() + timeoutMilliseconds;
  do {
    const selected = selectedRepository(repositories);
    if (selected) return selected;
    await new Promise(resolve => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  throw new VisibilityBaselineError('Native repository focus did not settle.', false);
}

async function waitForDifferentSelection(
  repositories: readonly GitRepository[],
  previousKey: string,
  timeoutMilliseconds: number,
): Promise<GitRepository | undefined> {
  const deadline = Date.now() + timeoutMilliseconds;
  for (;;) {
    const selected = selectedRepository(repositories);
    if (selected && selected.rootUri.toString() !== previousKey) return selected;
    if (Date.now() >= deadline) return undefined;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

export interface VisibilityBaselineTimings {
  readonly modeSettleMilliseconds?: number;
  readonly probeMilliseconds?: number;
  readonly selectionTimeoutMilliseconds?: number;
}

async function revealAllRepositories(
  execute: (command: string) => Promise<void>,
  settleMilliseconds: number,
): Promise<void> {
  await execute('workbench.scm.action.repositories.setSelectionMode.single');
  await new Promise(resolve => setTimeout(resolve, settleMilliseconds));
  await execute('workbench.scm.action.repositories.setSelectionMode.multiple');
  await new Promise(resolve => setTimeout(resolve, settleMilliseconds));
}

export async function establishVisibilityBaseline(
  repositories: readonly GitRepository[],
  candidateCommands: readonly string[],
  execute: (command: string) => Promise<void>,
  timings: VisibilityBaselineTimings = {},
): Promise<VisibilityBaseline> {
  const modeSettleMilliseconds = timings.modeSettleMilliseconds ?? 250;
  const probeMilliseconds = timings.probeMilliseconds ?? 0;
  const selectionTimeoutMilliseconds = timings.selectionTimeoutMilliseconds ?? 1_000;
  try {
    await revealAllRepositories(execute, modeSettleMilliseconds);

    const remainingCommands = [...candidateCommands];
    const mappings: VisibilityMapping[] = [];
    while (remainingCommands.length > 1) {
      const current = await waitForSelectedRepository(repositories, selectionTimeoutMilliseconds);
      const currentKey = current.rootUri.toString();
      let matchedIndex = -1;
      for (let index = 0; index < remainingCommands.length; index += 1) {
        const command = remainingCommands[index];
        await execute(command);
        // Native focus is updated before executeCommand resolves. Avoid a timer
        // here so the reversible probes are not painted one by one.
        if (await waitForDifferentSelection(repositories, currentKey, probeMilliseconds)) {
          mappings.push({ repository: current, command });
          matchedIndex = index;
          break;
        }
        await execute(command);
      }
      if (matchedIndex === -1) {
        throw new VisibilityBaselineError(
          'No native visibility command matched the focused repository.',
          false,
        );
      }
      remainingCommands.splice(matchedIndex, 1);
    }

    const finalRepository = await waitForSelectedRepository(
      repositories,
      selectionTimeoutMilliseconds,
    );
    if (remainingCommands.length !== 1) {
      throw new VisibilityBaselineError(
        'Every Git repository must have exactly one native visibility command.',
        false,
      );
    }
    mappings.push({ repository: finalRepository, command: remainingCommands[0] });

    return {
      mappings,
      hiddenRepositories: mappings.slice(0, -1).map(mapping => mapping.repository),
    };
  } catch (error) {
    let recoveryError: unknown;
    try {
      await revealAllRepositories(execute, modeSettleMilliseconds);
    } catch (recoveryFailure) {
      recoveryError = recoveryFailure;
    }

    const message = error instanceof VisibilityBaselineError
      ? error.message
      : 'Failed to map every repository in VS Code\'s native Repositories view.';
    if (recoveryError === undefined) {
      throw new VisibilityBaselineError(message, true, { cause: error });
    }
    throw new VisibilityBaselineError(
      `${message} RepoFocus could not restore the native all-visible state.`,
      false,
      { cause: new AggregateError([error, recoveryError], 'Visibility mapping and recovery failed.') },
    );
  }
}
