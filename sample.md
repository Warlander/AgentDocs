# Markdown in AgentDocs {#top}

Markdown source is preserved in the vault and rendered into the same sandboxed HTML viewer as native HTML documents.

> This sample exercises AgentDocs' basic and extended Markdown dialect.

## Extended syntax

| Feature | Example | Status |
| :--- | :--- | ---: |
| Emphasis | **bold**, *italic*, and ~~obsolete~~ | Supported |
| Inline extensions | ==highlighted==, H~2~O, x^2^, :rocket: | Supported |
| Automatic link | https://www.markdownguide.org | Supported |

- [x] Render Markdown to HTML
- [x] Preserve the original source
- [ ] Add the next custom DSL renderer

Document renderer
: A format adapter that accepts source text and emits a complete HTML page.

```ts
interface DocumentRenderer {
  type: string;
  extensions: readonly string[];
  render(source: string, title: string): string;
}
```

Footnotes work as well.[^details]

[^details]: AgentDocs uses `markdown-it` plus focused syntax plugins and `highlight.js`.

<details><summary>Raw HTML</summary>Basic Markdown-compatible HTML remains available inside the existing iframe sandbox and CSP.</details>
