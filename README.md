# RepoFocus

RepoFocus is a Preview VS Code extension for people who work in a parent folder containing many Git repositories. It keeps every repository registered with VS Code's built-in Git extension while removing clean repositories from the native Source Control view; a repository's complete native section returns when it has local changes, conflicts, incoming or outgoing commits, an unpublished branch, a rebase in progress, or an explicit always-show match. RepoFocus exists so actionable repositories fit on screen without folding clean ones or risking that hidden repositories stop being monitored.

## Features

- Filters VS Code's native Source Control view instead of replacing it with a custom dashboard.
- Preserves built-in Git monitoring, commands, commit input, and change groups.
- Detects staged, unstaged, untracked, conflicted, rebasing, incoming, outgoing, diverged, and unpublished states.
- Refreshes remote-tracking state with bounded, non-overlapping fetches; automatic fetch can be disabled.
- Restores every repository hidden by RepoFocus when filtering is disabled, compatibility is lost, or the extension stops.
- Copies diagnostics containing aggregate state only—no repository paths, remote URLs, credentials, or file contents.

## Requirements

- VS Code 1.131.0 or newer on desktop, with the built-in Git extension enabled.
- A trusted local workspace. Virtual and untrusted workspaces are not supported.
- Filtering starts at two detected repositories by default, so opening one specific repository always leaves it visible. `repofocus.minimumRepositoryCount` can change that threshold.
- VS Code's repository selection mode must be `multiple`, which is its default. RepoFocus reads that setting and stays out of the way when it is `single`; it never writes VS Code configuration on its own.
- Every repository must be visible in the Source Control Repositories view when RepoFocus starts filtering. If any are already hidden it says so and offers **RepoFocus: Reveal All Repositories in Source Control** rather than guessing, because VS Code gives an extension no way to tell which repositories are hidden.
- During initialization the native repository list makes one visible transition while RepoFocus verifies the repository mappings and applies the final filter.
- RepoFocus never opens, closes, focuses, or switches sidebar panes. VS Code creates the internal repository-visibility commands lazily, so RepoFocus waits quietly until the user first opens Source Control and then initializes filtering in place.
- Automatic remote detection performs Git fetches and can therefore invoke the authentication flow configured for Git and VS Code.

To build from source: Node.js 22 or newer and npm.

## Install

RepoFocus is not yet published. To try the Preview from source:

```sh
npm install
npm run vscode:prepublish
npm exec vsce package
```

In VS Code, run **Extensions: Install from VSIX...** and select the generated package. Published Preview builds will be available from [GitHub Releases](https://github.com/nao7sep/repofocus/releases) and the VS Code Marketplace after the first release passes packaged installation testing.

## Compatibility and safety

VS Code does not expose repository visibility through its public extension API. RepoFocus isolates its use of the built-in Source Control visibility commands behind validation and restores its own visibility changes if that validation or a later command fails. It never closes a clean repository and treats uncertain or failed state evaluation as actionable.

The native visibility menu does not publish enough state for RepoFocus to observe every manual visibility change made after filtering starts. Use **RepoFocus: Toggle Filtering** or **RepoFocus: Show All Repositories** while RepoFocus is active; native manual visibility behavior is preserved when filtering is disabled.

One compatibility limitation is worth stating plainly: VS Code creates the internal per-repository visibility commands only after Source Control has been opened, so an extension cannot distinguish "the view has not been opened yet" from "these commands were renamed by a VS Code update". RepoFocus reports which state it is in through **RepoFocus: Copy Diagnostics** and its output channel rather than pretending to know. A change to the surrounding command family *is* detected and reported as a compatibility failure.

## Documentation

See [docs/reference.md](docs/reference.md) for the actionability contract, settings, commands, remote behavior, and recovery guidance.

## License

MIT © 2026 Yoshinao Inoguchi

## Contact

Yoshinao Inoguchi — nao7sep@gmail.com
