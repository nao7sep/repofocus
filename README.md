# RepoFocus

Open a folder full of Git repositories and VS Code's Source Control view lists every single one — twenty entries, seventeen of which you haven't touched in weeks, and the three you are actually working in somewhere down the scroll. RepoFocus hides the quiet ones. A repository comes back the moment it has something waiting for you: local changes, a merge conflict, commits to push or pull, a branch you never published, a rebase you left half-finished. You can also pin repositories that should always stay in view.

It filters VS Code's *own* Source Control view rather than replacing it with a dashboard of its own, so a repository that reappears is the real thing — the same commit box, the same change groups, the same Git commands. Nothing is closed and nothing stops being watched: the built-in Git extension monitors a hidden repository exactly as it did before, which is why an edit to one brings it straight back. Your repositories can sit together under one parent folder or arrive as separate folders of a multi-root workspace; both work.

RepoFocus is for developers who keep many repositories open at once, and it is deliberately small — install it, and the first time you open Source Control it starts working. It is at `0.x`, in daily use by its author, and it reaches repository visibility through a VS Code internal rather than a public API, which is worth reading about under [Compatibility and safety](#compatibility-and-safety) before you adopt it.

![VS Code's Source Control view with filtering off, listing every repository, beside the same view with RepoFocus on, showing only the three repositories that have changes.](docs/images/source-control.png)

## Install

RepoFocus is on the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=nao7sep.repofocus). Open the Extensions view, search for **RepoFocus**, and install it — or from a terminal:

```sh
code --install-extension nao7sep.repofocus
```

Every release also attaches a `.vsix` and its SHA-256 digest to [GitHub Releases](https://github.com/nao7sep/repofocus/releases/latest), if you would rather install without the Marketplace: **Extensions → … → Install from VSIX…**.

Filtering turns itself on the first time you open Source Control. To switch it off — for this workspace, permanently, until you switch it back — run **RepoFocus: Toggle Filtering** from the Command Palette, or use the filter button in the Source Control title bar.

## Requirements

- VS Code 1.131.0 or newer, on the desktop, with the built-in Git extension enabled.
- A trusted local workspace. Virtual and untrusted workspaces are not supported.
- Two or more Git repositories. Below that RepoFocus leaves everything visible, so opening a single repository is never affected.
- Every Source Control provider in the window is a Git repository. VS Code's visibility commands cover all providers while RepoFocus can only read Git ones, so a workspace also running an SVN or Mercurial provider pauses filtering and says so rather than guessing.
- VS Code's repository selection mode set to `multiple`, which is its default. RepoFocus reads that setting and stays out of the way when it is `single`. It never writes VS Code's own configuration without asking — one recovery command changes that single setting, and only after you confirm it.

Detecting commits to push or pull means fetching, so RepoFocus performs bounded background Git fetches and can trigger whatever authentication you already have configured for Git. Automatic fetching can be turned off.

To build from source: Node.js 22 or newer, and npm.

## Compatibility and safety

VS Code does not expose repository visibility through its public extension API, so RepoFocus drives the built-in Source Control visibility commands instead. That is the honest cost of filtering the native view rather than building a replacement for it, and the extension is written around it: it validates those commands before using them, undoes its own visibility changes if validation or a later command fails, never closes a repository, and treats a state it could not evaluate as one that needs you.

One limitation is worth stating plainly. VS Code creates its internal per-repository visibility commands only after Source Control has been opened, so an extension cannot tell "the view hasn't been opened yet" apart from "these commands were renamed by a VS Code update". RepoFocus reports which state it believes it is in through **RepoFocus: Copy Diagnostics** and its output channel rather than pretending to know. A change to the surrounding command family *is* detected and reported as a compatibility failure.

Because VS Code publishes no event when you hide or show a repository yourself, use **RepoFocus: Toggle Filtering** or **RepoFocus: Show All Repositories** while RepoFocus is active; the native menu behaves normally again once filtering is off.

## Documentation

[docs/reference.md](docs/reference.md) covers exactly what counts as needing your attention, every setting and command, remote-fetch behavior, and how to recover if filtering gets stuck.

## License

MIT © 2026 Yoshinao Inoguchi

## Contact

Yoshinao Inoguchi — yoshinao@inoguchi.com — <https://inoguchi.com>

Questions, bug reports, and feature requests belong in [GitHub Issues](https://github.com/nao7sep/repofocus/issues). For anything security-related, e-mail instead of opening an issue, and please redact real repository paths, remote URLs, and branch names — a synthetic reproduction is enough.
