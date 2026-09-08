import path from 'node:path';
import hljs from 'highlight.js';
import MarkdownIt from 'markdown-it';
import markdownItAttrs from 'markdown-it-attrs';
import markdownItDeflist from 'markdown-it-deflist';
import { full as markdownItEmoji } from 'markdown-it-emoji';
import markdownItFootnote from 'markdown-it-footnote';
import markdownItMark from 'markdown-it-mark';
import markdownItSub from 'markdown-it-sub';
import markdownItSup from 'markdown-it-sup';
import markdownItTaskLists from 'markdown-it-task-lists';
import { renderAgentDoc } from './agentdoc.js';

export interface DocumentRenderOutput {
  html: string;
  title?: string;
  id?: string;
  schema?: string;
  warnings?: string[];
}

export interface DocumentRenderer {
  type: string;
  extensions: readonly string[];
  sourceExtension: string;
  render(source: string, title: string): string | DocumentRenderOutput;
}

export interface RenderedDocument {
  type: string;
  sourceFile: string;
  html: string;
  title?: string;
  id?: string;
  schema?: string;
  warnings?: string[];
}

export class DocumentInputError extends Error {
  constructor(message: string, readonly status: 415 | 422) {
    super(message);
  }
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

const markdown = new MarkdownIt({
  html: true,
  linkify: true,
  highlight(code, language) {
    if (!language || !hljs.getLanguage(language)) return '';
    return hljs.highlight(code, { language, ignoreIllegals: true }).value;
  },
});

type MarkdownPlugin = (md: typeof markdown) => void;
for (const plugin of [
  markdownItAttrs,
  markdownItDeflist,
  markdownItEmoji,
  markdownItFootnote,
  markdownItMark,
  markdownItSub,
  markdownItSup,
  markdownItTaskLists,
]) {
  (plugin as unknown as MarkdownPlugin)(markdown);
}

function renderMarkdown(source: string, title: string) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root { color-scheme: light dark; font-family: system-ui, sans-serif; line-height: 1.6; }
body { max-width: 900px; margin: 0 auto; padding: 2rem; overflow-wrap: break-word; }
img { max-width: 100%; }
a { color: #6ea8fe; }
pre, code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
code { padding: .1em .3em; background: rgba(128,128,128,.15); border-radius: 4px; }
pre { padding: 1rem; overflow-x: auto; background: rgba(128,128,128,.12); border-radius: 6px; }
pre code { padding: 0; background: none; }
blockquote { margin-left: 0; padding-left: 1rem; border-left: 4px solid #6b7280; color: #9ca3af; }
table { width: 100%; border-collapse: collapse; }
th, td { padding: .5rem; border: 1px solid #6b7280; text-align: left; }
dt { font-weight: 700; }
dd { margin-bottom: .75rem; }
mark { padding: 0 .15em; }
.contains-task-list { list-style: none; padding-left: 0; }
.task-list-item { list-style: none; }
.task-list-item-checkbox { margin: 0 .5rem 0 -1.4rem; }
.hljs-comment, .hljs-quote { color: #8b949e; }
.hljs-keyword, .hljs-selector-tag, .hljs-literal { color: #ff7b72; }
.hljs-string, .hljs-attr, .hljs-template-tag { color: #a5d6ff; }
.hljs-title, .hljs-function, .hljs-section { color: #d2a8ff; }
.hljs-number, .hljs-symbol, .hljs-bullet { color: #79c0ff; }
</style>
</head>
<body>
${markdown.render(source)}
</body>
</html>`;
}

export class DocumentRendererRegistry {
  private readonly byType = new Map<string, DocumentRenderer>();
  private readonly byExtension = new Map<string, DocumentRenderer>();

  constructor(renderers: readonly DocumentRenderer[]) {
    for (const renderer of renderers) {
      if (this.byType.has(renderer.type)) throw new Error(`duplicate document type: ${renderer.type}`);
      this.byType.set(renderer.type, renderer);
      for (const extension of renderer.extensions) {
        const normalized = extension.toLowerCase();
        if (this.byExtension.has(normalized)) throw new Error(`duplicate document extension: ${normalized}`);
        this.byExtension.set(normalized, renderer);
      }
    }
  }

  render(filename: string, source: string, title: string, requestedType?: string): RenderedDocument {
    const renderer = requestedType
      ? this.byType.get(requestedType.toLowerCase())
      : this.byExtension.get(path.extname(filename).toLowerCase());
    if (!renderer) {
      const description = requestedType ? `document type "${requestedType}"` : `file extension "${path.extname(filename) || '(none)'}"`;
      throw new DocumentInputError(`unsupported ${description}`, 415);
    }
    if (!source.trim()) throw new DocumentInputError('document is empty', 422);
    if (source.includes('\0')) throw new DocumentInputError('document contains null bytes', 422);

    try {
      const output = renderer.render(source, title);
      const html = typeof output === 'string' ? output : output.html;
      if (!html.trim()) throw new Error('renderer produced no HTML');
      return {
        type: renderer.type,
        sourceFile: `source${renderer.sourceExtension}`,
        html,
        ...(typeof output === 'string' ? {} : { title: output.title, id: output.id, schema: output.schema, warnings: output.warnings }),
      };
    } catch (error) {
      if (error instanceof DocumentInputError) throw error;
      const message = error instanceof Error ? error.message : 'unknown rendering error';
      throw new DocumentInputError(`invalid ${renderer.type} document: ${message}`, 422);
    }
  }
}

export const defaultDocumentRenderers = new DocumentRendererRegistry([
  {
    type: 'html',
    extensions: ['.html', '.htm'],
    sourceExtension: '.html',
    render: source => source,
  },
  {
    type: 'markdown',
    extensions: ['.md', '.markdown'],
    sourceExtension: '.md',
    render: renderMarkdown,
  },
  {
    type: 'agentdoc',
    extensions: ['.agentdoc'],
    sourceExtension: '.agentdoc',
    render: source => renderAgentDoc(source, value => markdown.render(value)),
  },
]);

export function titleFromFilename(filename: string) {
  const extension = path.extname(filename);
  return path.basename(filename, extension) || 'Untitled';
}
