# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Settings API: read/update vault directory (with live vault swap), default project, and git identity

### Fixed

- Open document now reloads automatically when a new version is pushed; version dropdown refreshes too
- External commits pushed directly into the vault git repo are now detected and indexed automatically

### Changed

- Docker container now restarts automatically on boot (`unless-stopped`)
- Projects in the docs list are now ordered by most recent document instead of alphabetically

## [0.1.1] - 2026-08-07

### Fixed

- Docker image failed to start (`docker-entrypoint.sh: permission denied`) — executable bit was lost on commit from Windows

## [0.1.0] - 2026-08-07

Initial release.

[Unreleased]: https://github.com/Warlander/AgentDocs/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/Warlander/AgentDocs/releases/tag/v0.1.1
[0.1.0]: https://github.com/Warlander/AgentDocs/releases/tag/v0.1.0
