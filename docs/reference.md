# RepoFocus reference

## Actionability

A repository remains visible when RepoFocus observes at least one of these states:

- merge conflicts;
- staged changes;
- unstaged changes;
- untracked files;
- a rebase in progress;
- incoming commits;
- outgoing commits;
- a named branch with no upstream when the repository has a remote;
- an `alwaysShow` pattern match; or
- an evaluation error or inconsistent state.

A detached HEAD, unborn branch, or local-only branch is not remote work by itself. Multiple reasons can apply simultaneously. RepoFocus keeps uncertain state visible.

Incoming and outgoing counts come from VS Code's built-in Git extension. RepoFocus does not fetch or run status commands, so it does not override the user's VS Code autofetch setting or Git workflow.

## Setting

`repofocus.alwaysShow` accepts up to 100 Git repository glob patterns of at most 512 characters each. A pattern matches either the path VS Code reports for a repository or its directory name. Matching is case-sensitive except on Windows. Brace expansion is disabled so one setting cannot generate an unbounded pattern set. Invalid synced or hand-edited input fails visible rather than hiding an uncertain exemption.

For a workspace opened at a parent directory, representative patterns are `company`, `clients/*`, and `experiments/**`. A repository that is itself a multi-root workspace folder has no relative form in the VS Code API, so matching its bare directory name is the portable choice. Two repositories with the same directory name both match the same bare-name pattern; use a longer path when they should differ.

`scm.repositories.visible` only sizes VS Code's Repositories section and does not cap repository visibility. RepoFocus neither reads nor changes it.

RepoFocus cycles the native repository selection mode through `single` and back to `multiple` when establishing an all-visible baseline. It does not write repository files. Installing RepoFocus delegates native per-repository visibility to it while filtering is enabled.

## Visibility initialization

RepoFocus activates when Source Control is opened. It waits for the built-in Git extension's initial scan and for VS Code to register one internal visibility command per Source Control provider. A single repository needs no mapping. A non-Git provider pauses filtering because RepoFocus cannot safely associate the provider with the opaque command.

For two or more Git repositories, RepoFocus first establishes an all-visible baseline. It then maps commands without assuming that Git API order matches SCM registration order:

1. Hide all commands except one; the sole visible repository identifies that command.
2. Reveal one unknown command.
3. Hide the already identified repository; the new sole visible repository identifies the revealed command.
4. Repeat until every command is mapped.

This takes exactly `3N−3` reversible mapping toggles for `N` repositories rather than a quadratic command-by-repository search. The final reconciliation hides clean repositories. Mapping runs only after initialization, stable repository topology changes, a user selection-mode change that leaves multiple mode, or an explicit retry from a paused state.

Each native command has a 10-second execution bound. The selection after each isolating change gets 1 second to settle, the complete mapping gets 60 seconds, and lazy command registration gets at most 100 attempts spaced 50 milliseconds apart. A topology revision interrupts stale work. RepoFocus serializes native commands, coalesces topology bursts, and restores its owned hides before stopping on failure. If a toggle rejects, its outcome is unknown: RepoFocus does not invert it again, waits up to one additional command bound for the underlying operation to settle, and uses the selection-mode reset to establish a known all-visible state. A command that never settles leaves visibility reported as unknown without further toggles.

There is no periodic audit, command polling after the initial retry window, window-focus job, or network scheduler. Git-state events update one repository's classification; visibility reconciliation runs only when that repository crosses between clean and actionable.

## Commands

- **RepoFocus: Toggle Filtering** disables filtering and restores RepoFocus-owned hides, or enables filtering using the verified mapping. The state is stored per workspace.
- **RepoFocus: Refresh** rereads `alwaysShow`, reevaluates the Git state VS Code already holds, and retries visibility initialization only when it is not mapped. It does not fetch, run Git status, or rebuild a healthy mapping.
- **RepoFocus: Copy Diagnostics** copies versions, aggregate counts, Git API state, mapping state, and the `alwaysShow` pattern count. It excludes repository paths, remote URLs, branch names, file names, file contents, and error details.

## What RepoFocus can reach

- It reads branch, upstream, ahead/behind, rebase, and change-count state exposed by VS Code's built-in Git extension.
- It invokes VS Code's internal Source Control visibility and repository-selection-mode commands. It does not invoke Git operations.
- It stores whether filtering is enabled in VS Code's per-workspace extension storage. It writes no files and holds no credentials.
- It copies aggregate diagnostics to the clipboard only when the user runs the command.

## Recovery

Disabling filtering or deactivating the extension restores every confirmed hide in RepoFocus's command ledger. A native compatibility failure also attempts that restoration and remains failed for the window so it cannot loop. Because native visibility commands are non-idempotent toggles, a rejected toggle is recovered through an all-visible selection-mode reset rather than a compensating toggle. If the underlying command does not settle within the recovery bound, RepoFocus leaves the state failed, reports the unknown visibility count, and issues no more native visibility commands.

If filtering is paused because repositories are still loading, Source Control commands are not registered, or another provider is present, leave Source Control open and run **RepoFocus: Refresh** after the condition changes. If compatibility failed, copy diagnostics and reload the window. Report repeatable failures at [GitHub Issues](https://github.com/nao7sep/repofocus/issues).

VS Code publishes no event for manual per-repository visibility changes. While filtering is enabled, use RepoFocus rather than the native hide/show menu. Turning filtering off restores RepoFocus's owned set and returns visibility control to the user.
