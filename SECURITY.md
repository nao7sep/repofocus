# Security Policy

## Supported versions

RepoFocus is at `0.x`. Security fixes land on the latest published version only; there are no maintained older lines.

## Reporting a vulnerability

Please report privately rather than in a public issue, through GitHub's private vulnerability reporting on this repository: **Security → Report a vulnerability**.

Include what you need to make the problem reproducible — the RepoFocus and VS Code versions, the workspace shape (single folder or multi-root), and the steps you took. Please do not include real repository paths, remote URLs, branch names, or credentials; a redacted or synthetic reproduction is enough and is preferred.

You can expect an acknowledgement, and a fix or an explanation of why the behavior is intended. If a report turns out to be a functional bug rather than a security issue, it moves to a normal public issue with your agreement.

## What RepoFocus can and cannot reach

Scope worth knowing when judging whether something is a vulnerability:

- It reads repository **state** through VS Code's built-in Git extension — branch, tracking status, and change counts. It does not read file contents, and it runs no Git command that writes to a repository.
- It performs **fetches** against remotes already configured in your repositories, on the interval set by `repofocus.fetchIntervalMinutes`. Setting that to `0` disables extension-owned fetching entirely.
- It stores one piece of state: whether filtering is on, in VS Code's per-workspace storage. It writes no files of its own and holds no credentials.
- Its **diagnostics** command copies aggregate state only. It is designed to exclude repository paths, remote URLs, branch names, and file contents so the output can be pasted into an issue safely. A diagnostics payload that leaks any of those is a security bug worth reporting.
