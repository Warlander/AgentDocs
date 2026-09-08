# AgentDocs Vault

Local vault for AI-generated AgentDoc, HTML, and Markdown documents. Every supported format
is rendered to an HTML page, stored in a plain git-versioned directory, and shown
through the web UI. Fully offline after install.

## Why?

Personally, when using LLM's for software development, brainstorming and research I like output to be shown in a form of HTML pages - unlike Markdown, HTML can be pretty much anything and is able to adapt to any need easier. I can parse documents in my head faster and more efficiently, ensure alignment by comparing visual mockups with image in my head, see what's important at the first glance as it sticks out far more than with Markdown. However, this brings some problems - handling and keeping track of documents can get messy, and that's why this app exists. It keeps track of all the current and historical versions of docs, and keeps them neatly organized by project and easily accessible. There are multiple ways to handle agentic documentation, and that's what currently works for my use case.

I will likely keep building on top of it over time according to my needs - however, it's definitely a small side project that exists just so I can focus on what's actually important (aka actual main projects), but given it may be useful to someone with the same use case as me I decided to publish it. :)

<img width="2559" height="1340" alt="image" src="https://github.com/user-attachments/assets/5f54aeee-8c6d-41a3-907d-264dad4d13fe" />

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

## Configuration

Open the settings window via the ⚙ button in the UI to change:

- **Vault location** — the git repo where documents live. Applies immediately
  (no restart): the server initializes the new directory if needed and reindexes
  it. Documents are not copied — old ones stay in the old vault.
- **Default project** — fallback when an upload names no project.
- **Git identity** — `user.name` / `user.email` for vault commits.

Vault location is resolved in this order:

1. `VAULT_DIR` env var
2. `agentdocs.toml` (`[vault] dir`) — written by the settings window
3. `<repo>/vault` (bare metal) or `/vault` (Docker)

`agentdocs.toml` lives next to the repo (override with `APP_CONFIG`). It must sit
outside the vault, since `vault.toml` is inside the vault and cannot point at
itself. Ports come from `vault.toml` (`[server]`) or `PORT` / `DOCS_PORT` env
vars and are bound once at startup — changing them requires a restart.

> **Docker note:** `agentdocs.toml` is written to the container filesystem and
> does not survive container recreation. Prefer changing the `./vault:/vault`
> bind mount in `docker-compose.yml` for a permanent move.

> **Security: no authentication.** Anyone who can reach the API port can upload
> and read documents. The bare-metal server binds `127.0.0.1`, but the Docker
> setup binds `0.0.0.0` — only run it on networks you fully trust. Never expose
> it to the internet.

## CLI

```sh
npm run build -w vault-cli
npm link -w vault-cli      # puts `vault` on PATH

vault add sample.html --project demos [--title T] [--source-repo PATH] [--model M] [--transcript REF]
vault add sample.md --project demos
vault add sample.agentdoc --project demos
vault list
vault open <slug>
vault reindex
```

Targets `VAULT_URL` (default `http://localhost:3000`) — works against
bare-metal server or container, since it uploads file content.

## Document formats

- `.agentdoc` — validated, versioned semantic source rendered into standardized
  HTML. Its required `@id` is the stable vault slug, and its `@title` is the
  canonical document, browser, search, and side-panel title. Latest views render
  the source in memory through the current schema and theme; SHA-pinned history
  keeps the committed HTML snapshot.
- `.html` / `.htm` — served unchanged.
- `.md` / `.markdown` — rendered with CommonMark plus tables, fenced and
  highlighted code, autolinks, footnotes, heading IDs, definition lists,
  strikethrough, task lists, emoji, mark, subscript, and superscript.

New uploads keep the original UTF-8 source as `source.<ext>` and the web-ready
result as `index.html`. Empty, invalid UTF-8, null-containing, and unsupported
uploads return a client error without changing the vault.

### AgentDoc example

Top-level directives may appear in any order. The renderer always emits title,
kind, description, references, evaluations, decision log, open decisions, locked
decisions, risks, tests, steps, and freeform sections in that canonical order,
omitting empty optional sections.

```text
@schema agentdocs/v1
@id example-specification
@title "Example Specification"
@kind specification
@description
This document specifies a small example. The renderer owns its presentation.
@end-description

@evaluations
@evaluation metric=size level=0
The change is small.
@end-evaluation
@evaluation metric=complexity level=0
The implementation has one obvious path.
@end-evaluation
@evaluation metric=risk level=0
The behavior is isolated.
@end-evaluation
@end-evaluations

@section format=markdown title="Acceptance Criteria"
- The output is deterministic.
@end-section
```

Specifications and implementation plans require all three 0–3 evaluations with
one-sentence reasons; implementation plans also require structured steps. Other
document kinds are `exploration`, `handoff`, and `design-doc`. Decisions, risks,
tests, references, Markdown/HTML freeform sections, option layouts, and the CSS
escape hatch are described in the
[AgentDoc DSL specification](architecture/agentdoc-dsl-specification.agentdoc).
Locked decisions tile three per row by default and accept `layout=full` when one
winner needs more room; full-width entries render before compact ones to avoid
partial rows. Their cards visibly separate the problem, winning decision, and
supporting description. Acceptance criteria are represented as test rows rather
than a separate freeform section.
Generated tables use a contained header and border, a tinted identity column,
and alternating body rows. Evaluations use colored reasoned rows with a connected
0–3 capsule whose active segment is the sole score, and place each rationale
directly beneath its metric scale.

## Layout

- `packages/server` — Hono API (:3000) + document parser/renderers + raw document origin (:3001, restrictive CSP, iframe-sandboxed)
- `packages/web` — React + Vite + Tailwind UI
- `packages/cli` — `vault` CLI (thin HTTP client)
- `vault/` — created on first run: `vault.toml`, `index.db` (gitignored, rebuildable), `docs/<project>/<slug>/` with source, rendered `index.html`, and metadata

## License

[MIT](LICENSE)
