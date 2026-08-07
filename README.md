# AgentDocs Vault

Local vault for AI-generated single-file HTML documents. Plain git-versioned
directory + web UI + CLI. Fully offline after install.

<!-- screenshot -->

## Requirements

- Node.js ≥ 20.11
- git

## Quick start (bare metal)

```sh
npm install
npm run dev        # API on :3000, docs origin on :3001, web UI on :5173
```

Production mode: `npm run build && npm start` — server serves the built UI on :3000.

## Docker

```sh
docker compose up --build   # UI+API on localhost:3000, docs origin on :3001
```

Vault persisted at `./vault` on the host (git repo, human-navigable).
Git identity via env: `GIT_USER_NAME` / `GIT_USER_EMAIL`.

> **Security: no authentication.** Anyone who can reach the API port can upload
> and read documents. The bare-metal server binds `127.0.0.1`, but the Docker
> setup binds `0.0.0.0` — only run it on networks you fully trust. Never expose
> it to the internet.

## CLI

```sh
npm run build -w vault-cli
npm link -w vault-cli      # puts `vault` on PATH

vault add sample.html --project demos [--title T] [--source-repo PATH] [--model M] [--transcript REF]
vault list
vault open <slug>
vault reindex
```

Targets `VAULT_URL` (default `http://localhost:3000`) — works against
bare-metal server or container, since it uploads file content.

## Layout

- `packages/server` — Hono API (:3000) + raw document origin (:3001, restrictive CSP, iframe-sandboxed)
- `packages/web` — React + Vite + Tailwind UI
- `packages/cli` — `vault` CLI (thin HTTP client)
- `vault/` — created on first run: `vault.toml`, `index.db` (gitignored, rebuildable), `docs/<project>/<slug>/`

## License

[MIT](LICENSE)
