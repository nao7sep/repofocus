import { FilteringStateTransitionError } from './filteringStateTransaction';

/** The extension's presentation boundary, per the error-handling conventions. */
export type FailedOperation = 'compatibility' | 'copy-diagnostics' | 'open-documentation' | 'toggle';

const incompatibleMessage = 'RepoFocus stopped filtering because VS Code\'s internal visibility '
  + 'contract changed. Reload the window after copying diagnostics.';

export function describeMappingState(state: string): string | undefined {
  switch (state) {
    case 'awaiting-native-commands':
      return 'RepoFocus is waiting for VS Code to create its internal repository-visibility '
        + 'commands. Keep Source Control open and run RepoFocus: Refresh.';
    case 'loading-repositories':
      return 'RepoFocus is waiting for VS Code to finish its initial Git repository scan.';
    case 'other-scm-providers':
      return 'RepoFocus supports windows whose Source Control providers are all Git repositories.';
    case 'incompatible':
      return incompatibleMessage;
    default:
      return undefined;
  }
}

export function describeFailure(operation: FailedOperation, error: unknown): string {
  switch (operation) {
    case 'compatibility':
      return incompatibleMessage;
    case 'copy-diagnostics':
      return 'Couldn\'t copy the diagnostics to the clipboard.';
    case 'open-documentation':
      return 'Couldn\'t open the documentation.';
    case 'toggle':
      return error instanceof FilteringStateTransitionError && error.rollbackErrors.length > 0
        ? 'RepoFocus could not fully restore filtering after a host failure. Reload the window, '
          + 'then see RepoFocus output for details.'
        : 'RepoFocus could not change filtering and restored the previous setting. '
          + 'See RepoFocus output for details.';
  }
}
