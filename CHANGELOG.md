# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.2] - 2026-08-22

### Fixed

- Replaced ambiguous native-toggle compensation with a known all-visible reset, so a rejected toggle is never blindly inverted again.
- Added action/outcome logging for copied diagnostics and made structured log redaction safe for circular fields.

## [0.1.1] - 2026-08-21

### Changed

- RepoFocus now activates when Source Control is opened instead of at general startup.
- Removed extension-owned Git fetching, periodic audits, window-focus work, and remote-policy settings. Incoming and outgoing status now follows the built-in Git extension without overriding the user's autofetch choice.
- Made untracked files, incoming commits, outgoing commits, and unpublished branches consistently actionable. `alwaysShow` is now the only RepoFocus setting.
- Replaced quadratic repository-command discovery with a bounded linear mapping that is exercised with 50 repositories.

### Fixed

- Stabilized slow and out-of-order repository discovery, same-path provider replacement, close/reopen remapping, and native focus convergence on Windows.
- Made visibility initialization start from an all-visible baseline, coalesce topology bursts, abort stale work, and fail visible when VS Code's internal contract changes.
- Prevented unchanged Git-state events and healthy manual refreshes from rebuilding visibility mappings.
- Bounded native commands, complete mapping, lazy command registration, and all-visible recovery so native failures cannot create unbounded work.

## [0.1.0] - 2026-08-18

### Added

- First public release.
