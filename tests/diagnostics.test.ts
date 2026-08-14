import { describe, expect, it } from 'vitest';
import { createDiagnostics } from '../src/diagnostics';

describe('createDiagnostics', () => {
  it('summarizes state and reasons without repository identifiers or error details', () => {
    const diagnostics = createDiagnostics({
      extensionVersion: '0.1.0',
      vscodeVersion: '1.131.0',
      platform: 'darwin-arm64',
      filteringEnabled: true,
      filteringActive: true,
      compatible: true,
      baselineEstablished: true,
      nativeMappingState: 'mapped',
      repositoryStates: [
        { actionable: false, reasons: [] },
        { actionable: true, reasons: [{ kind: 'unstaged', count: 2 }] },
        { actionable: true, reasons: [{ kind: 'error', detail: '/private/repo: https://user:token@example.test' }] },
      ],
      hiddenByRepoFocusCount: 1,
      remoteFailureCount: 1,
      policy: {
        includeIncomingCommits: true,
        includeOutgoingCommits: true,
        includeUntrackedFiles: true,
      },
      alwaysShowPatternCount: 2,
      fetchIntervalMinutes: 5,
      minimumRepositoryCount: 2,
    });
    const parsed = JSON.parse(diagnostics) as Record<string, unknown>;

    expect(parsed).toMatchObject({
      repositoryCount: 3,
      actionableRepositoryCount: 2,
      hiddenByRepoFocusCount: 1,
      remoteFailureCount: 1,
      reasonCounts: { unstaged: 1, error: 1 },
    });
    expect(diagnostics).not.toContain('/private/repo');
    expect(diagnostics).not.toContain('example.test');
    expect(diagnostics).not.toContain('token');
  });
});
