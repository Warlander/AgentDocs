import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApps, type Apps } from '../src/app.js';

let dir: string;
let apps: Apps;

function agentDoc(title: string) {
  return `@schema agentdocs/v1
@id live-doc
@title "${title}"
@kind specification
@description
This description contains ${title}. It verifies current source rendering.
@end-description
@evaluations
@evaluation metric=size level=0
The document is small.
@end-evaluation
@evaluation metric=complexity level=0
The rendering path is direct.
@end-evaluation
@evaluation metric=risk level=0
The behavior is isolated.
@end-evaluation
@end-evaluations
@references
@reference doc=demo/report label="Report"
@end-references`;
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'docs-test-'));
  apps = await createApps(dir);
  const form = new FormData();
  form.append('file', new File(['<p>v1</p>'], 'report.html', { type: 'text/html' }));
  form.append('project', 'demo');
  await apps.api.request('/api/docs', { method: 'POST', body: form });
});

afterEach(async () => {
  apps.db.close();
  await rm(dir, { recursive: true, force: true });
});

describe('docs origin', () => {
  it('serves uploaded HTML exactly', async () => {
    const res = await apps.docsApp.request('/demo/report');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<p>v1</p>');
  });

  it('sets restrictive CSP and nosniff', async () => {
    const res = await apps.docsApp.request('/demo/report');
    expect(res.headers.get('Content-Security-Policy')).toBe(
      "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; font-src data:");
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Content-Type')).toContain('text/html');
  });

  it.each(['/a..b/c', '/ABC/def', '/a/b/c', '/%2E%2E/etc'])('rejects traversal-ish path: %s', async p => {
    expect((await apps.docsApp.request(p)).status).toBe(404);
  });

  it('rejects malformed sha', async () => {
    expect((await apps.docsApp.request('/demo/report?sha=zzz')).status).toBe(400);
  });

  it('serves local mermaid build', async () => {
    const res = await apps.docsApp.request('/vendor/mermaid.min.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/javascript');
    expect(await res.text()).toContain('mermaid');
  });

  it('404s unknown sha', async () => {
    expect((await apps.docsApp.request(`/demo/report?sha=${'0'.repeat(40)}`)).status).toBe(404);
  });

  it('serves historical version by sha', async () => {
    const versions = await (await apps.api.request('/api/docs/report/versions')).json();
    const form = new FormData();
    form.append('file', new File(['<p>v2</p>'], 'report.html', { type: 'text/html' }));
    form.append('project', 'demo');
    await apps.api.request('/api/docs', { method: 'POST', body: form });
    const res = await apps.docsApp.request(`/demo/report?sha=${versions[0].sha}`);
    expect(await res.text()).toBe('<p>v1</p>');
    expect(await (await apps.docsApp.request('/demo/report')).text()).toBe('<p>v2</p>');
  });

  it('serves rendered Markdown as HTML', async () => {
    const form = new FormData();
    form.append('file', new File(['# Markdown'], 'notes.md', { type: 'text/markdown' }));
    form.append('project', 'demo');
    await apps.api.request('/api/docs', { method: 'POST', body: form });
    const res = await apps.docsApp.request('/demo/notes');
    expect(res.headers.get('Content-Type')).toContain('text/html');
    expect(await res.text()).toContain('<h1>Markdown</h1>');
  });

  it('renders latest AgentDoc source in memory while preserving historical HTML', async () => {
    const form = new FormData();
    form.append('file', new File([agentDoc('Original')], 'live.agentdoc', { type: 'application/vnd.agentdocs+text' }));
    form.append('project', 'demo');
    await apps.api.request('/api/docs', { method: 'POST', body: form });
    const versions = await (await apps.api.request('/api/docs/live-doc/versions')).json();
    const sourceFile = path.join(dir, 'docs/demo/live-doc/source.agentdoc');
    const htmlFile = path.join(dir, 'docs/demo/live-doc/index.html');
    const committedHtml = readFileSync(htmlFile, 'utf8');
    writeFileSync(sourceFile, agentDoc('Current'));

    const latest = await (await apps.docsApp.request('/demo/live-doc')).text();
    const historical = await (await apps.docsApp.request(`/demo/live-doc?sha=${versions[0].sha}`)).text();
    expect(latest).toContain('<title>Current</title>');
    expect(latest).toContain("postMessage({ type: 'agentdocs:navigate'");
    expect(historical).toContain('<title>Original</title>');
    expect(readFileSync(htmlFile, 'utf8')).toBe(committedHtml);
  });
});
