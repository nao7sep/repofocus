export type BranchState =
  | { readonly kind: 'named'; readonly upstream: 'configured' | 'missing'; readonly ahead?: number; readonly behind?: number }
  | { readonly kind: 'detached' | 'unborn' }
  | { readonly kind: 'unknown'; readonly detail: string };

export interface RepositoryActionabilityInput {
  readonly mergeChanges: number;
  readonly stagedChanges: number;
  readonly unstagedChanges: number;
  readonly untrackedChanges: number;
  readonly rebaseInProgress: boolean;
  readonly remoteCount: number;
  readonly branch: BranchState;
  readonly alwaysShow?: boolean;
  readonly evaluationError?: string;
}

export type ActionabilityReason =
  | { readonly kind: 'conflicts'; readonly count: number }
  | { readonly kind: 'staged'; readonly count: number }
  | { readonly kind: 'unstaged'; readonly count: number }
  | { readonly kind: 'untracked'; readonly count: number }
  | { readonly kind: 'rebase' }
  | { readonly kind: 'incoming'; readonly count: number }
  | { readonly kind: 'outgoing'; readonly count: number }
  | { readonly kind: 'unpublished' }
  | { readonly kind: 'always-show' }
  | { readonly kind: 'error'; readonly detail: string };

export interface RepositoryActionability {
  readonly actionable: boolean;
  readonly reasons: readonly ActionabilityReason[];
}

function invalidCount(name: string, value: number | undefined): string | undefined {
  return value === undefined || !Number.isSafeInteger(value) || value < 0
    ? `${name} must be a non-negative safe integer.`
    : undefined;
}

export function classifyRepository(
  input: RepositoryActionabilityInput,
): RepositoryActionability {
  const reasons: ActionabilityReason[] = [];
  const countErrors = [
    invalidCount('mergeChanges', input.mergeChanges),
    invalidCount('stagedChanges', input.stagedChanges),
    invalidCount('unstagedChanges', input.unstagedChanges),
    invalidCount('untrackedChanges', input.untrackedChanges),
    invalidCount('remoteCount', input.remoteCount),
  ].filter((error): error is string => error !== undefined);

  if (input.branch.kind === 'named' && input.branch.upstream === 'configured') {
    const aheadError = invalidCount('branch.ahead', input.branch.ahead);
    if (aheadError) countErrors.push(aheadError);
    const behindError = invalidCount('branch.behind', input.branch.behind);
    if (behindError) countErrors.push(behindError);
  }

  const errors = [input.evaluationError, ...countErrors];
  if (input.branch.kind === 'unknown') errors.push(input.branch.detail);
  for (const detail of errors) {
    if (detail) reasons.push({ kind: 'error', detail });
  }

  if (input.mergeChanges > 0) reasons.push({ kind: 'conflicts', count: input.mergeChanges });
  if (input.stagedChanges > 0) reasons.push({ kind: 'staged', count: input.stagedChanges });
  if (input.unstagedChanges > 0) reasons.push({ kind: 'unstaged', count: input.unstagedChanges });
  if (input.untrackedChanges > 0) {
    reasons.push({ kind: 'untracked', count: input.untrackedChanges });
  }
  if (input.rebaseInProgress) reasons.push({ kind: 'rebase' });
  if (input.alwaysShow) reasons.push({ kind: 'always-show' });

  if (input.branch.kind === 'named') {
    if (input.branch.upstream === 'configured') {
      if ((input.branch.behind ?? 0) > 0) {
        reasons.push({ kind: 'incoming', count: input.branch.behind ?? 0 });
      }
      if ((input.branch.ahead ?? 0) > 0) {
        reasons.push({ kind: 'outgoing', count: input.branch.ahead ?? 0 });
      }
    } else if (input.remoteCount > 0) {
      reasons.push({ kind: 'unpublished' });
    }
  }

  return { actionable: reasons.length > 0, reasons };
}
