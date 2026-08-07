# AgentDocs

## Commands

- Dev: `npm run dev` (API :3000, docs :3001, UI :5173)
- Test: `npm test` (vitest, server + vault-cli workspaces)
- Typecheck: `npm run typecheck` — run after TS edits
- Build: `npm run build` (web + vault-cli only; server runs via tsx)

## Structure

- `packages/server` — Hono API + SQLite index, serves built UI in prod
- `packages/web` — React/Vite UI
- `packages/cli` — `vault` command (commander)
- `vault/` — data dir, itself a git repo; every doc write = git commit

## Gotchas

- `agentdocs.toml` must live outside the vault (`vault.toml` inside can't point at itself)
- Don't hand-edit files under `vault/` without committing — it's a git repo
- Ports are bound once at startup; port config changes need a restart

## Changelog

- Every user-facing change gets a `CHANGELOG.md` entry under `[Unreleased]`, in the same commit/PR as the change.
- Only user-facing changes belong in the changelog. Skip internal/technical changes (refactors, tooling, CI) unless they are visible or relevant to users.
- If a change modifies something introduced in the same unreleased version, update the existing entry (or leave it untouched if the change is part of the same feature) instead of adding a new one.
- Release commits do the changelog chores: move `[Unreleased]` entries into a versioned section with the release date and update the compare links at the bottom.
