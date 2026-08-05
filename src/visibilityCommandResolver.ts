export const visibilityCommandPrefix = 'workbench.scm.action.toggleRepositoryVisibility.';

export interface RepositoryIdentity {
  readonly rootUri: { toString(): string };
}

export interface VisibilityMapping {
  readonly repository: RepositoryIdentity;
  readonly command: string;
}

export class VisibilityCompatibilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VisibilityCompatibilityError';
  }
}

function commandHandle(command: string): number | undefined {
  if (!command.startsWith(visibilityCommandPrefix)) {
    return undefined;
  }

  const suffix = command.slice(visibilityCommandPrefix.length);
  const match = /^scm(\d+)$/.exec(suffix);
  return match ? Number.parseInt(match[1], 10) : undefined;
}

export function resolveVisibilityCommands(
  repositories: readonly RepositoryIdentity[],
  commands: readonly string[],
): readonly VisibilityMapping[] {
  const candidates = commands
    .map(command => ({ command, handle: commandHandle(command) }))
    .filter((candidate): candidate is { command: string; handle: number } => candidate.handle !== undefined)
    .sort((left, right) => left.handle - right.handle);

  if (candidates.length !== repositories.length) {
    throw new VisibilityCompatibilityError(
      `Expected one native visibility command per Git repository; found ${candidates.length} commands for ${repositories.length} repositories.`,
    );
  }

  return repositories.map((repository, index) => ({
    repository,
    command: candidates[index].command,
  }));
}
