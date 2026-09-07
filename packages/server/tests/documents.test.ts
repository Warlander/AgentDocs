import { describe, expect, it } from 'vitest';
import {
  DocumentInputError,
  DocumentRendererRegistry,
  defaultDocumentRenderers,
  titleFromFilename,
  type DocumentRenderer,
} from '../src/documents.js';

describe('document renderers', () => {
  it('keeps HTML unchanged', () => {
    const rendered = defaultDocumentRenderers.render('report.html', '<p>hello</p>', 'Report');
    expect(rendered).toEqual({ type: 'html', sourceFile: 'source.html', html: '<p>hello</p>' });
  });

  it('renders Markdown Guide basic and extended syntax', () => {
    const source = `# Heading {#custom-id}

**bold** and *italic* and ~~deleted~~ and ==marked== with H~2~O and x^2^ :rocket:

https://example.com

| Left | Right |
| --- | ---: |
| A | B |

Term
: Definition

- [x] done
- [ ] todo

\`\`\`js
const answer = 42;
\`\`\`

Footnote.[^1]

[^1]: Note text.
`;
    const { html } = defaultDocumentRenderers.render('report.md', source, 'Report & Notes');
    expect(html).toContain('<title>Report &amp; Notes</title>');
    expect(html).toContain('<h1 id="custom-id">Heading</h1>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>italic</em>');
    expect(html).toContain('<s>deleted</s>');
    expect(html).toContain('<mark>marked</mark>');
    expect(html).toContain('<sub>2</sub>');
    expect(html).toContain('<sup>2</sup>');
    expect(html).toContain('🚀');
    expect(html).toContain('<a href="https://example.com">https://example.com</a>');
    expect(html).toContain('<table>');
    expect(html).toContain('<dl>');
    expect(html).toContain('task-list-item-checkbox');
    expect(html).toContain('hljs-keyword');
    expect(html).toContain('footnote-ref');
  });

  it.each([
    ['notes.txt', 'text'],
    ['notes.md', '   '],
    ['notes.html', '<p>before\0after</p>'],
  ])('rejects invalid input: %s', (filename, source) => {
    expect(() => defaultDocumentRenderers.render(filename, source, 'Notes')).toThrow(DocumentInputError);
  });

  it('converts renderer failures into client errors', () => {
    const broken: DocumentRenderer = {
      type: 'broken',
      extensions: ['.broken'],
      sourceExtension: '.broken',
      render: () => { throw new Error('bad syntax'); },
    };
    const registry = new DocumentRendererRegistry([broken]);
    expect(() => registry.render('x.broken', 'content', 'X')).toThrowError(
      expect.objectContaining({ status: 422, message: 'invalid broken document: bad syntax' }),
    );
  });

  it('supports explicit document types for custom DSL integrations', () => {
    const renderer: DocumentRenderer = {
      type: 'diagram',
      extensions: ['.diagram'],
      sourceExtension: '.diagram',
      render: source => `<svg>${source}</svg>`,
    };
    const registry = new DocumentRendererRegistry([renderer]);
    expect(registry.render('source.txt', 'shape', 'Diagram', 'diagram').html).toBe('<svg>shape</svg>');
  });
});

describe('titleFromFilename', () => {
  it.each([
    ['report.html', 'report'],
    ['report.md', 'report'],
    ['report.markdown', 'report'],
  ])('strips the extension from %s', (filename, title) => {
    expect(titleFromFilename(filename)).toBe(title);
  });
});
