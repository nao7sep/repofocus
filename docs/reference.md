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

`repofocus.minimumRepositoryCount` defaults to `2`. RepoFocus shows every repository and does not initialize native filtering while fewer repositories are detected. Set it to `1` only if a clean single-repository workspace should be filtered too.

`scm.repositories.visible` is irrelevant to RepoFocus. It sizes the Source Control Repositories section and places no cap on which repositories can be visible, so RepoFocus neither reads it nor contributes a default for it.

RepoFocus requires VS Code's `multiple` repository-selection mode, which is VS Code's default. It reads that setting and declines to filter while it is `single`, recovering by itself when the value changes back. RepoFocus writes no VS Code configuration.

It never changes the active sidebar pane. After the user opens Source Control, VS Code registers the internal repository-visibility commands; RepoFocus then maps each one to its repository by reversibly hiding the focused repository and reading which repository receives focus. When no remaining command moves focus, one repository is still visible and its command is the single unmapped one, by elimination.

That elimination needs every repository visible at the start. If repositories were already hidden, more than one command is left unmapped and RepoFocus cannot identify them: a hidden repository never holds focus, and revealing one produces no observable event. RepoFocus reports this instead of guessing.

## Commands

- **RepoFocus: Toggle Filtering** enables or disables automatic filtering. Turning it on while filtering cannot run — Source Control has not been opened, repositories are already hidden, the selection mode is `single`, another Source Control provider is active, or compatibility was lost — reports which of those it is rather than appearing to do nothing.
- **RepoFocus: Refresh** fetches eligible remotes, reevaluates every repository, and reconciles visibility. It also retries native mapping whenever filtering is paused, which is the way back from a paused state RepoFocus cannot observe ending — another extension's Source Control provider being removed, or repositories revealed through VS Code's own menu.
- **RepoFocus: Show All Repositories** disables filtering and restores repositories hidden by RepoFocus.
- **RepoFocus: Copy Diagnostics** copies versions, aggregate counts, effective policy, and compatibility state without repository identifiers or Git content. Its `nativeMappingState` field distinguishes a mapped session from one waiting for Source Control to be opened, one declining because repositories are already hidden, the selection mode is `single`, or another Source Control provider is active, and one that has lost compatibility.
- **RepoFocus: Reveal All Repositories in Source Control** restores an all-visible repository list when some are hidden, after confirming that it changes VS Code's `scm.repositories.selectionMode` setting — the only mechanism VS Code offers for this, and the one place RepoFocus writes configuration.

The filtering toggle is workspace presentation state and survives normal VS Code reloads. Internal command mappings are discovered again each time RepoFocus activates.

## Remote behavior

RepoFocus asks the built-in Git extension to fetch repositories that have remotes when automatic fetching is enabled and either incoming or outgoing detection is enabled. It uses the built-in Git API's ahead and behind values after fetch rather than parsing Git output.

Authentication remains in the existing Git and VS Code flow. A fetch failure does not trigger repeated RepoFocus notifications: the affected repository stays visible with an error reason, the aggregate failure appears in copied diagnostics, and a later successful fetch clears the error.

## Recovery

RepoFocus records only the repositories it hides. Disabling filtering, running **Show All Repositories**, losing compatibility, and extension shutdown all restore that owned set without closing Git repositories.

If compatibility validation fails, run **RepoFocus: Copy Diagnostics**, then reload the VS Code window; a compatibility failure lasts for the life of the window by design. **RepoFocus: Show All Repositories** is offered as a recovery action only when repositories are actually still hidden, so a failure notification without it means nothing was left hidden.

A VS Code update can change the internal visibility commands even when the public Git API remains compatible. RepoFocus detects and reports a change to the surrounding command family, but it cannot detect a rename of the per-repository commands themselves: VS Code registers those lazily, so their absence is indistinguishable from a Source Control view that has not been opened yet. In that case filtering silently does nothing, `nativeMappingState` reads `awaiting-native-commands`, and the output channel records the wait. Report the copied diagnostics at [GitHub Issues](https://github.com/nao7sep/repofocus/issues).
