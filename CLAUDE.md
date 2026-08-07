# AgentDocs

## Changelog

- Every user-facing change gets a `CHANGELOG.md` entry under `[Unreleased]`, in the same commit/PR as the change.
- Only user-facing changes belong in the changelog. Skip internal/technical changes (refactors, tooling, CI) unless they are visible or relevant to users.
- If a change modifies something introduced in the same unreleased version, update the existing entry (or leave it untouched if the change is part of the same feature) instead of adding a new one.
- Release commits do the changelog chores: move `[Unreleased]` entries into a versioned section with the release date and update the compare links at the bottom.
