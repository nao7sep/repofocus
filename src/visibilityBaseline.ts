import type { GitRepository } from './gitApi';
import type { RepositoryIdentity, VisibilityMapping } from './visibilityCommandResolver';

export class VisibilityBaselineError extends Error {
  constructor(message: string, options?: ErrorOptions) {
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
  throw new VisibilityBaselineError('Native repository focus did not settle.');
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

export async function establishAllVisibleBaseline(
  repositories: readonly GitRepository[],
  candidateMappings: readonly VisibilityMapping[],
  execute: (command: string) => Promise<void>,
  timeoutMilliseconds = 1_000,
  probeMilliseconds = 0,
): Promise<VisibilityBaseline> {
  try {
    await execute('workbench.scm.action.repositories.setSelectionMode.single');
    await new Promise(resolve => setTimeout(resolve, 250));
    await execute('workbench.scm.action.repositories.setSelectionMode.multiple');
    await new Promise(resolve => setTimeout(resolve, 250));

    const remainingCommands = candidateMappings.map(mapping => mapping.command);
    const mappings: VisibilityMapping[] = [];
    while (remainingCommands.length > 1) {
      const current = await waitForSelectedRepository(repositories, timeoutMilliseconds);
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
        throw new VisibilityBaselineError('No native visibility command matched the focused repository.');
      }
      remainingCommands.splice(matchedIndex, 1);
    }

    const finalRepository = await waitForSelectedRepository(repositories, timeoutMilliseconds);
    if (remainingCommands.length !== 1) {
      throw new VisibilityBaselineError('Every Git repository must have exactly one native visibility command.');
    }
    mappings.push({ repository: finalRepository, command: remainingCommands[0] });

    return {
      mappings,
      hiddenRepositories: mappings.slice(0, -1).map(mapping => mapping.repository),
    };
  } catch (error) {
    try {
      await execute('workbench.scm.action.repositories.setSelectionMode.single');
      await new Promise(resolve => setTimeout(resolve, 100));
      await execute('workbench.scm.action.repositories.setSelectionMode.multiple');
    } catch {
      // Preserve the original compatibility failure.
    }
    if (error instanceof VisibilityBaselineError) throw error;
    throw new VisibilityBaselineError(
      'Failed to map and select every repository in VS Code\'s native Repositories view.',
      { cause: error },
    );
  }
}
