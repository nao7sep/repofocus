import type { GitRepository } from './gitApi';
import type { VisibilityMapping } from './visibilityCommandResolver';

export class VisibilityProbeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'VisibilityProbeError';
  }
}

/**
 * Repositories were hidden in the native Repositories view before RepoFocus
 * mapped, so they cannot be identified: focus transfer is the only signal VS
 * Code offers, a hidden repository can never hold focus, and revealing one
 * produces no observable event. Measured in the Extension Host, not assumed.
 */
export class RepositoriesAlreadyHiddenError extends Error {
  constructor(readonly unmappedCommandCount: number) {
    super(
      `${unmappedCommandCount} repositories are already hidden in the Source Control Repositories view, `
      + 'so RepoFocus cannot identify them.',
    );
    this.name = 'RepositoriesAlreadyHiddenError';
  }
}

/** The owner of every visibility mutation the probe makes. */
export interface VisibilityProbeLedger {
  hide(command: string): Promise<void>;
  reveal(command: string): Promise<void>;
}

export interface VisibilityProbeTimings {
  readonly probeMilliseconds?: number;
  readonly selectionTimeoutMilliseconds?: number;
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
  throw new VisibilityProbeError('Native repository focus did not settle.');
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

/**
 * Maps every internal visibility command to its repository from whatever
 * visibility state the view is already in, writing no VS Code configuration.
 *
 * Each round hides the focused repository and reads which repository receives
 * focus. When no remaining command moves focus, exactly one repository is still
 * visible; its command is the single unmapped one, by elimination. More than one
 * unmapped command means repositories were hidden before RepoFocus started —
 * an unmappable state, reported rather than guessed at.
 */
export async function probeVisibilityMappings(
  repositories: readonly GitRepository[],
  candidateCommands: readonly string[],
  ledger: VisibilityProbeLedger,
  timings: VisibilityProbeTimings = {},
): Promise<readonly VisibilityMapping[]> {
  const probeMilliseconds = timings.probeMilliseconds ?? 0;
  const selectionTimeoutMilliseconds = timings.selectionTimeoutMilliseconds ?? 1_000;
  const remainingCommands = [...candidateCommands];
  const mappings: VisibilityMapping[] = [];

  while (remainingCommands.length > 0) {
    const current = await waitForSelectedRepository(repositories, selectionTimeoutMilliseconds);
    const currentKey = current.rootUri.toString();
    let matchedIndex = -1;
    for (let index = 0; index < remainingCommands.length; index += 1) {
      const command = remainingCommands[index];
      await ledger.hide(command);
      // Native focus is updated before executeCommand resolves. Avoid a timer
      // here so the reversible probes are not painted one by one.
      if (await waitForDifferentSelection(repositories, currentKey, probeMilliseconds)) {
        mappings.push({ repository: current, command });
        matchedIndex = index;
        break;
      }
      await ledger.reveal(command);
    }
    // No command moved focus: the focused repository is the only visible one.
    if (matchedIndex === -1) break;
    remainingCommands.splice(matchedIndex, 1);
  }

  if (remainingCommands.length === 0) {
    // Every command was consumed while a repository is still visible, so the
    // command set and the repository set do not describe the same thing.
    throw new VisibilityProbeError(
      'Every Git repository must be mapped to exactly one native visibility command.',
    );
  }
  if (remainingCommands.length > 1) {
    throw new RepositoriesAlreadyHiddenError(remainingCommands.length);
  }

  const lastVisible = await waitForSelectedRepository(repositories, selectionTimeoutMilliseconds);
  mappings.push({ repository: lastVisible, command: remainingCommands[0] });

  const mappedRepositories = new Set(mappings.map(mapping => mapping.repository.rootUri.toString()));
  if (mappedRepositories.size !== mappings.length || mappings.length !== repositories.length) {
    throw new VisibilityProbeError(
      'Every Git repository must be mapped to exactly one native visibility command.',
    );
  }
  return mappings;
}
