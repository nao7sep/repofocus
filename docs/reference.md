# RepoFocus reference

## Actionability

A repository remains visible when RepoFocus observes at least one of these states:

- merge conflicts;
- staged changes;
- unstaged changes;
- untracked files when enabled;
- a rebase in progress;
- incoming commits when enabled;
- outgoing commits when enabled;
- a named branch with no upstream when outgoing detection is enabled and the repository has a remote;
- an `alwaysShow` pattern match; or
- an evaluation or remote-refresh error.

A detached HEAD, unborn branch, or local-only branch is not remote work by itself. Multiple reasons can apply simultaneously. If state is unavailable or inconsistent, RepoFocus keeps the repository visible.

## Settings

`repofocus.includeUntrackedFiles`, `repofocus.includeOutgoingCommits`, and `repofocus.includeIncomingCommits` independently control their corresponding actionability reasons and default to enabled.

`repofocus.fetchIntervalMinutes` controls extension-owned background fetches and defaults to 5. Set it to 0 to disable those fetches and rely on VS Code and manual Git refreshes. Fetches are non-overlapping and use at most two repositories concurrently.

`repofocus.alwaysShow` accepts workspace-relative Git repository glob patterns. For a workspace opened at a parent directory, `company`, `clients/*`, and `experiments/**` are representative patterns. Matching is case-sensitive except on Windows.

VS Code's native `scm.repositories.visible` setting must be at least the number of monitored repositories, including clean ones. RepoFocus contributes a default of 100; an explicit user or workspace value still takes precedence. RepoFocus needs a known all-visible baseline to distinguish its own visibility changes from pre-existing native state.

RepoFocus also requires VS Code's `multiple` repository-selection mode. During initialization it uses VS Code's native selection-mode commands to switch through `single` and back to `multiple`, verifies native repository mappings, and reconciles directly from the resulting known visibility state without an intermediate restore-to-all cycle.

## Commands

- **RepoFocus: Toggle Filtering** enables or disables automatic filtering.
- **RepoFocus: Refresh** fetches eligible remotes, reevaluates every repository, and reconciles visibility.
- **RepoFocus: Show All Repositories** disables filtering and restores repositories hidden by RepoFocus.
- **RepoFocus: Copy Diagnostics** copies versions, aggregate counts, effective policy, and compatibility state without repository identifiers or Git content.

The filtering toggle is workspace presentation state and survives normal VS Code reloads. Internal command mappings are discovered again each time RepoFocus activates.

## Remote behavior

RepoFocus asks the built-in Git extension to fetch repositories that have remotes when automatic fetching is enabled and either incoming or outgoing detection is enabled. It uses the built-in Git API's ahead and behind values after fetch rather than parsing Git output.

Authentication remains in the existing Git and VS Code flow. A fetch failure does not trigger repeated RepoFocus notifications: the affected repository stays visible with an error reason, the aggregate failure appears in copied diagnostics, and a later successful fetch clears the error.

## Recovery

RepoFocus records only the repositories it hides. Disabling filtering, running **Show All Repositories**, losing compatibility, and extension shutdown all restore that owned set without closing Git repositories.

If compatibility validation fails, first ensure `scm.repositories.visible` is high enough for the workspace, then reload the VS Code window. Run **RepoFocus: Copy Diagnostics** and **RepoFocus: Show All Repositories** before reporting a failure. A VS Code update can change the internal visibility commands even when the public Git API remains compatible; report the copied diagnostics at [GitHub Issues](https://github.com/nao7sep/repofocus/issues).
