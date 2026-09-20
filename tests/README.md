# RepoFocus's areas, and the tests that stand for them

`npm test` is the type check plus this whole suite: at about a second it is already a fixed, balanced
run, so nothing selects a subset of it. `npm run test:full` adds the integration lane, which builds
the extension and launches a real VS Code Extension Host twice over throwaway Git repositories — once
on a single folder holding fifty of them, one with a remote to go ahead and behind, and once on a
multi-root workspace whose two folders are repositories with the same directory name under unrelated
parents. Those files are `tests/integration/index.ts` and `tests/integration/multiRoot.ts`; they are
not `*.test.ts`, so Vitest never collects them, and they are the only place `src/extension.ts` and
`src/gitApi.ts` run against the real host. They belong to the full gate, and no area below stands on
them.

This file is the balance judgement the `tests-folder-conventions` require — which areas RepoFocus
has, and which tests stand for each — so a reader can tell what a green run covered, and an area with
no test standing for it is visible rather than merely absent. `tests/area-map.test.ts` holds every
path below to what is on disk.

Paths are relative to this folder.

| Area | What it covers | Tests standing for it |
|---|---|---|
| Repository actionability | The rule that decides whether a repository needs attention — conflicts, staged, unstaged, or untracked changes, a rebase in progress, incoming or outgoing commits, a named branch with no upstream, an uncertain state — and the translation of what VS Code's Git extension reports into that rule's input. | `actionability.test.ts`, `repositoryStateAdapter.test.ts` |
| The `alwaysShow` setting | RepoFocus's one setting: glob patterns matched against the path VS Code reports for a repository and against its own directory name, so a bare name works in either workspace shape, within the declared pattern-count and length limits. | `alwaysShow.test.ts` |
| The VS Code host boundary | What RepoFocus learns from the built-in Git extension — repositories opened, replaced, changed, and closed, and the per-repository subscriptions it must dispose — and the deadline on every wait for the host, where a timed-out activation never starts a rival one. | `gitRepositoryMonitor.test.ts`, `hostOperation.test.ts` |
| Native visibility mapping | Discovering the built-in per-repository visibility commands, probing them to learn which command belongs to which repository without assuming provider order, and pausing rather than guessing when repositories are still loading or a non-Git Source Control provider is present. | `visibilityCommandResolver.test.ts`, `visibilityBaseline.test.ts`, `visibilityMappingCoordinator.test.ts` |
| Applying and undoing visibility | Hiding only clean repositories, tracking by command every hide RepoFocus owns so it can be given back, bounding and single-flighting the uncancellable native command seam, and the all-visible reset used when a toggle's outcome is ambiguous. | `visibilityReconciler.test.ts`, `nativeVisibilityCommandExecutor.test.ts`, `nativeVisibilityReset.test.ts` |
| The filtering choice | Turning filtering on and off as one transition across native visibility, the per-workspace stored value, and the context key the Source Control menus read, rolled back when any one of the three fails. | `filteringStateTransaction.test.ts` |
| Logging and diagnostics | The structured log lines and the Copy Diagnostics payload: counts, versions, and state, with secrets redacted and no repository path, branch name, remote URL, file name, or error detail. | `logger.test.ts`, `diagnostics.test.ts` |
| Files the repository stands behind | The subjects that are files rather than modules: the licence and third-party notices the VSIX carries, the manifest's licence field, and this map. | `packageMetadata.test.ts`, `area-map.test.ts` |
