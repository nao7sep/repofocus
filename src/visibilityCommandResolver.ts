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

/**
 * The visibility commands cover every Source Control provider, not only Git
 * repositories, and focus transfer can only observe Git ones. A workspace with
 * another SCM provider is therefore unsupported rather than broken — VS Code
 * has not changed, so this must not be reported as a compatibility failure.
 */
export class OtherScmProvidersError extends Error {
  constructor(readonly commandCount: number, readonly repositoryCount: number) {
    super(
      `VS Code has ${commandCount} Source Control providers but only ${repositoryCount} `
      + 'are Git repositories, so RepoFocus cannot tell them apart.',
    );
    this.name = 'OtherScmProvidersError';
  }
}

export const selectionModeCommandPrefix = 'workbench.scm.action.repositories.setSelectionMode.';

/**
 * VS Code registers these eagerly at startup, unlike the per-repository
 * visibility commands, which appear only once Source Control has been rendered.
 * Their absence therefore means the internal command family moved; their
 * presence says nothing about whether the view has been opened yet.
 */
export const selectionModeCommands = {
  single: `${selectionModeCommandPrefix}single`,
  multiple: `${selectionModeCommandPrefix}multiple`,
} as const;

export type VisibilityCommandDiscovery =
  | { readonly kind: 'ready'; readonly commands: readonly string[] }
  | { readonly kind: 'pending' | 'excess' | 'unsupported'; readonly commandCount: number };

function commandHandle(command: string): number | undefined {
  if (!command.startsWith(visibilityCommandPrefix)) {
    return undefined;
  }

  const suffix = command.slice(visibilityCommandPrefix.length);
  const match = /^scm(\d+)$/.exec(suffix);
  return match ? Number.parseInt(match[1], 10) : undefined;
}

export function findVisibilityCommands(commands: readonly string[]): readonly string[] {
  return commands
    .map(command => ({ command, handle: commandHandle(command) }))
    .filter((candidate): candidate is { command: string; handle: number } => candidate.handle !== undefined)
    .sort((left, right) => left.handle - right.handle)
    .map(candidate => candidate.command);
}

export function discoverVisibilityCommands(
  repositoryCount: number,
  commands: readonly string[],
): VisibilityCommandDiscovery {
  const candidates = findVisibilityCommands(commands);
  if (!commands.includes(selectionModeCommands.multiple)) {
    return { kind: 'unsupported', commandCount: candidates.length };
  }
  if (candidates.length === repositoryCount) return { kind: 'ready', commands: candidates };
  return {
    kind: candidates.length < repositoryCount ? 'pending' : 'excess',
    commandCount: candidates.length,
  };
}
