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

`repofocus.fetchIntervalMinutes` controls extension-owned background fetches and defaults to 5. It accepts whole minutes from 1 through 1440; set it to 0 to disable those fetches and rely on VS Code and manual Git refreshes. Fetching is also inactive while filtering is off or paused, the VS Code window is in the background, repository discovery is incomplete, the repository threshold is not met, or both remote policies are disabled. Fetches use at most two repositories concurrently. A fetch that exceeds the 120-second wait bound is reported and remains registered until VS Code's underlying Git promise settles, so later intervals cannot pile another uncancellable fetch onto that repository.

`repofocus.alwaysShow` accepts up to 100 Git repository glob patterns of at most 512 characters each. A pattern matches a repository if it matches **either the repository's path as VS Code reports it, or the repository's own directory name**. Matching is case-sensitive except on Windows. Brace expansion is deliberately disabled so one setting cannot generate an unbounded pattern set. If hand-edited or synced configuration bypasses these bounds, RepoFocus keeps every repository visible rather than evaluating unbounded input or hiding an uncertain exemption.

For a workspace opened at a parent directory, paths are workspace-relative: `company`, `clients/*`, and `experiments/**` are representative. In a multi-root workspace, a repository nested inside a workspace folder is matched folder-first (`frontend/packages/api`), while a repository that **is** a workspace folder has no relative form — VS Code returns its absolute path — and is matched by its name, `repofocus`.

Matching the name as well as the path is what makes the setting portable: an absolute pattern would work only on the machine it was written on. The trade is that two repositories sharing a directory name in different roots both match a bare-name pattern. That is usually the intent, since a name names a repository rather than a location; write a longer path when it is not.

`repofocus.minimumRepositoryCount` defaults to `2`. RepoFocus shows every repository and does not initialize native filtering while fewer repositories are detected. Set it to `1` only if a clean single-repository workspace should be filtered too.

`scm.repositories.visible` is irrelevant to RepoFocus. It sizes the Source Control Repositories section and places no cap on which repositories can be visible, so RepoFocus neither reads it nor contributes a default for it.

RepoFocus requires VS Code's `multiple` repository-selection mode. It reads that setting and declines to filter while it is `single`, recovering by itself when the value changes back. It also contributes `multiple` as that setting's default, so the mode it needs is the mode a fresh install gets; on current VS Code that is already the registered default, making the contribution a no-op rather than a change to anyone's editor.

RepoFocus does not write repository files or settings. It can change VS Code's `scm.repositories.selectionMode` setting in two recovery cases: automatically once per extension session, when filtering is enabled and the initial native repository list is already hidden in a way that prevents mapping; and after confirmation for **Reveal All Repositories in Source Control**. RepoFocus cannot distinguish a stale list restored by VS Code from repositories hidden deliberately before mapping, so the automatic recovery reveals either kind. Both paths pass through `single` and return to `multiple`, which is the only mechanism VS Code exposes for restoring an all-visible repository list. Concurrent reset requests coalesce, and the complete two-transition reset has one 60-second bound.

It never changes the active sidebar pane. RepoFocus waits for the built-in Git extension's initial repository scan to finish. After the user opens Source Control, VS Code registers the internal repository-visibility commands; RepoFocus then maps each one to its repository by reversibly hiding the focused repository and reading which repository receives focus. When no remaining command moves focus, one repository is still visible and its command is the single unmapped one, by elimination. That probe is visible: the repository list makes one bounded pass before the filter settles, and repeats only after the stable repository topology changes or recovery finds that the mapping drifted. Each native command has a 10-second execution bound, and a complete probe stops after 60 seconds or 500 toggle attempts; hitting a bound pauses filtering instead of issuing more native work.

That elimination needs every repository visible at the start. If repositories were already hidden, more than one command is left unmapped and RepoFocus cannot identify them: a hidden repository never holds focus, and revealing one produces no observable event. While filtering is enabled, RepoFocus performs one bounded all-visible reset and retries from a known state instead of guessing the mapping.

## Commands

- **RepoFocus: Toggle Filtering** enables or disables automatic filtering. Turning it on while filtering cannot run — the initial Git scan is still running, Source Control has not been opened, the selection mode is `single`, another Source Control provider is active, or compatibility was lost — reports which of those it is rather than appearing to do nothing.
- **RepoFocus: Refresh** fetches eligible remotes, reevaluates every repository, and reconciles visibility. It also retries native mapping whenever filtering is paused, which is the way back from a paused state RepoFocus cannot observe ending — another extension's Source Control provider being removed, or repositories revealed through VS Code's own menu.
- **RepoFocus: Show All Repositories** disables filtering and restores repositories hidden by RepoFocus.
- **RepoFocus: Copy Diagnostics** copies versions, aggregate counts, effective policy, the built-in Git API state, and compatibility state without repository identifiers or Git content. Its `nativeMappingState` field distinguishes a mapped session from one waiting for the initial Git scan or Source Control commands, one declining because the selection mode is `single` or another Source Control provider is active, and one that has lost compatibility.
- **RepoFocus: Reveal All Repositories in Source Control** restores an all-visible repository list after confirming that it cycles VS Code's `scm.repositories.selectionMode` setting through `single` and back to `multiple`.

The filtering toggle is workspace presentation state and survives normal VS Code reloads. Internal command mappings are discovered again each time RepoFocus activates.

## Remote behavior

RepoFocus asks the built-in Git extension to fetch repositories that have remotes when filtering is active, automatic fetching is enabled, the repository threshold is met, and either incoming or outgoing detection is enabled. It uses the built-in Git API's ahead and behind values after fetch rather than parsing Git output.

Authentication remains in the existing Git and VS Code flow. A fetch failure does not trigger repeated RepoFocus notifications: the affected repository stays visible with an error reason, the aggregate failure appears in copied diagnostics, and a later successful fetch clears the error.

Each remote-refresh run logs aggregate counts rather than repository identifiers. When a run completes, RepoFocus audits its native mapping and requests recovery only if the repository or command topology has drifted; a healthy mapping is not probed or toggled again.

## What RepoFocus can reach

Useful when judging whether something it did is a bug or a security problem:

- It reads repository **state** through VS Code's built-in Git extension — branch, tracking status, and change counts. It does not read file contents, and it runs no Git command that writes to a repository.
- It performs **fetches** against remotes already configured in your repositories, on the `repofocus.fetchIntervalMinutes` interval. Setting that to `0` disables extension-owned fetching entirely.
- It stores one thing: whether filtering is on, in VS Code's per-workspace storage. It writes no files of its own and holds no credentials.
- Its **diagnostics** command copies aggregate state only, and is designed to exclude repository paths, remote URLs, branch names, and file contents so the output is safe to paste into an issue. A payload that leaks any of those is a bug worth reporting privately.

## Recovery

RepoFocus records only the repositories it hides. Disabling filtering, running **Show All Repositories**, losing compatibility, and extension shutdown all restore that owned set without closing Git repositories.

RepoFocus also audits convergence after remote refreshes and once every five minutes while the VS Code window is focused. Concurrent audits coalesce. An audit compares stable repository identities and the native command set; it does not toggle a healthy list, and a paused state that requires a Git/configuration event or user retry is not retried by the timer. If the initial native list is already hidden, startup mapping restores an all-visible native state at most once per extension session and maps again.

If compatibility validation fails, run **RepoFocus: Copy Diagnostics**, then reload the VS Code window; a compatibility failure lasts for the life of the window by design. **RepoFocus: Show All Repositories** is offered as a recovery action only when repositories are actually still hidden, so a failure notification without it means nothing was left hidden.

A VS Code update can change the internal visibility commands even when the public Git API remains compatible. RepoFocus detects and reports a change to the surrounding command family, but it cannot detect a rename of the per-repository commands themselves: VS Code registers those lazily, so their absence is indistinguishable from a Source Control view that has not been opened yet. In that case filtering silently does nothing, `nativeMappingState` reads `awaiting-native-commands`, and the output channel records the wait. Report the copied diagnostics at [GitHub Issues](https://github.com/nao7sep/repofocus/issues).
