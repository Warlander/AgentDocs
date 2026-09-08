# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- AgentDoc v1: a validated directive DSL with canonical metadata, five document kinds, evaluations, decision lifecycles, risks, tests, implementation steps, rich Markdown/HTML sections, scoped CSS, and deterministic rendering
- Source-aware latest rendering and schema migration infrastructure; historical revisions continue to serve their committed HTML snapshots
- Vault-native AgentDoc references with synchronized iframe, sidebar, header, search, and version navigation
- Extensible document renderer registry with HTML and Markdown support; Markdown includes the basic and extended syntax documented by Markdown Guide, with `sample.md` as a working example
- Original document sources are preserved beside the rendered `index.html` artifact
- Settings API: read/update vault directory (with live vault swap), default project, and git identity
- Favorite documents: hover a list row and click the star — favorited docs get a golden star and tint and pin to the top of their project section; stored server-side via `PATCH /api/docs/:slug`
- Sidebar divider between the docs list and the viewer is now draggable; width is remembered per browser
- Clicking the open doc's title copies the raw document URL (pinned to the selected version when one is chosen) for pasting into agent conversations or browsers
- Smart collapsing: projects show at most 8 non-favorite documents (favorites always visible); expand with "Show 8 more" / "Show all" — expansion resets when the browser tab closes. Cap configurable in Settings ("Documents shown per project")
- Mermaid diagrams in documents: the docs origin serves a local Mermaid build at `/vendor/mermaid.min.js` (CDN scripts are blocked by the docs CSP)

### Fixed

- Clicking an internal document reference now selects the destination in the vault UI, so the previously selected document can be clicked to return
- Invalid, empty, non-UTF-8, null-containing, malformed multipart, and unsupported document uploads now return 4xx responses instead of causing server errors or partial writes
- Open document now reloads automatically when a new version is pushed; version dropdown refreshes too
- External commits pushed directly into the vault git repo are now detected and indexed automatically

### Changed

- AgentDoc source owns its immutable vault ID and editable title; conflicting IDs are rejected instead of silently suffixed
- Locked decisions now use a responsive three-column grid with distinct problem, decision, and description regions; individual `layout=full` entries render first to avoid partial rows, and acceptance criteria belong in structured tests
- Standard tables now combine a tinted identity column with alternating rows; evaluations use colored 0–3 capsule scales as the sole score with reasoning directly beneath each metric
- Shared agent authoring guidance now targets concise `.agentdoc` source and avoids routine headless-browser document rereads
- Docker container now restarts automatically on boot (`unless-stopped`)
- Projects in the docs list are now ordered by most recent document instead of alphabetically
- Empty-state text now hints that agents can upload documents to the vault

### Removed

- Project filter dropdown and Upload button from the docs UI — the tool is primarily agent-driven; uploads go through the `vault` CLI or the API

## [0.1.1] - 2026-08-07

### Fixed

- Docker image failed to start (`docker-entrypoint.sh: permission denied`) — executable bit was lost on commit from Windows

## [0.1.0] - 2026-08-07

Initial release.

[Unreleased]: https://github.com/Warlander/AgentDocs/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/Warlander/AgentDocs/releases/tag/v0.1.1
[0.1.0]: https://github.com/Warlander/AgentDocs/releases/tag/v0.1.0
