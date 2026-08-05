import type { ActionabilityReason, ActionabilityPolicy, RepositoryActionability } from './actionability';

export interface RepoFocusDiagnosticsInput {
  readonly extensionVersion: string;
  readonly vscodeVersion: string;
  readonly platform: string;
  readonly filteringEnabled: boolean;
  readonly filteringActive: boolean;
  readonly compatible: boolean;
  readonly baselineEstablished: boolean;
  readonly repositoryStates: readonly RepositoryActionability[];
  readonly hiddenByRepoFocusCount: number;
  readonly remoteFailureCount: number;
  readonly policy: ActionabilityPolicy;
  readonly alwaysShowPatternCount: number;
  readonly fetchIntervalMinutes: number;
  readonly minimumRepositoryCount: number;
}

export function createDiagnostics(input: RepoFocusDiagnosticsInput): string {
  const reasonCounts: Partial<Record<ActionabilityReason['kind'], number>> = {};
  for (const state of input.repositoryStates) {
    for (const reason of state.reasons) {
      reasonCounts[reason.kind] = (reasonCounts[reason.kind] ?? 0) + 1;
    }
  }

  return JSON.stringify({
    schemaVersion: 1,
    extensionVersion: input.extensionVersion,
    vscodeVersion: input.vscodeVersion,
    platform: input.platform,
    filteringEnabled: input.filteringEnabled,
    filteringActive: input.filteringActive,
    compatible: input.compatible,
    baselineEstablished: input.baselineEstablished,
    repositoryCount: input.repositoryStates.length,
    actionableRepositoryCount: input.repositoryStates.filter(state => state.actionable).length,
    hiddenByRepoFocusCount: input.hiddenByRepoFocusCount,
    remoteFailureCount: input.remoteFailureCount,
    reasonCounts,
    settings: {
      ...input.policy,
      alwaysShowPatternCount: input.alwaysShowPatternCount,
      fetchIntervalMinutes: input.fetchIntervalMinutes,
      minimumRepositoryCount: input.minimumRepositoryCount,
    },
  }, undefined, 2);
}
