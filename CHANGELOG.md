# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Stabilized repository identity, initial discovery, visibility mapping, remote-refresh convergence, and shutdown logging on Windows.
- Added bounded recovery when VS Code restores a stale hidden-repository list.
- Bounded native visibility probes and prevented periodic audits from retrying paused states indefinitely.
- Prevented unchanged Git-state events from scheduling visibility work and compiled `alwaysShow` patterns once per configuration change.
- Disabled automatic fetching when filtering cannot use it, rejected sub-minute intervals, and prevented timed-out underlying fetches from accumulating.

## [0.1.0] - 2026-08-18

### Added

- First public release.
