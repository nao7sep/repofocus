import type { BranchState, RepositoryActionabilityInput } from './actionability';
import { gitStatus, type GitBranch, type GitRepositoryState } from './gitApi';

function branchState(head: GitBranch | undefined): BranchState {
  if (!head) return { kind: 'unborn' };
  if (head.name) {
    return head.upstream
      ? {
          kind: 'named',
          upstream: 'configured',
          ahead: head.ahead,
          behind: head.behind,
        }
      : { kind: 'named', upstream: 'missing' };
  }
  if (head.commit) return { kind: 'detached' };
  return { kind: 'unknown', detail: 'Git reported HEAD without a branch name or commit.' };
}

export function toActionabilityInput(state: GitRepositoryState): RepositoryActionabilityInput {
  const mixedUntrackedChanges = state.workingTreeChanges.filter(change => change.status === gitStatus.untracked);
  return {
    mergeChanges: state.mergeChanges.length,
    stagedChanges: state.indexChanges.length,
    unstagedChanges: state.workingTreeChanges.length - mixedUntrackedChanges.length,
    untrackedChanges: state.untrackedChanges.length + mixedUntrackedChanges.length,
    rebaseInProgress: state.rebaseCommit !== undefined,
    remoteCount: state.remotes.length,
    branch: branchState(state.HEAD),
  };
}
