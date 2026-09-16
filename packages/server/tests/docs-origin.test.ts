import { readFileSync, symlinkSync, writeFileSync } from 'node:fs';
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
  apps.stop();
  apps.db.close();
  await rm(dir, { recursive: true, force: true });
});

describe('docs origin', () => {
  it('serves uploaded HTML exactly', async () => {
    const res = await apps.docsApp.request('/demo/report/');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<p>v1</p>');
  });

  it('sets restrictive CSP and nosniff', async () => {
    const res = await apps.docsApp.request('/demo/report/');
    expect(res.headers.get('Content-Security-Policy')).toBe(
      "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src data:");
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Content-Type')).toContain('text/html');
  });

  it.each(['/a..b/c', '/ABC/def', '/a/b/c', '/%2E%2E/etc'])('rejects traversal-ish path: %s', async p => {
    expect((await apps.docsApp.request(p)).status).toBe(404);
  });

  it('rejects malformed sha', async () => {
    expect((await apps.docsApp.request('/demo/report?sha=zzz')).status).toBe(400);
  });

  it('redirects latest and legacy history URLs canonically', async () => {
    const latest = await apps.docsApp.request('/demo/report');
    expect(latest.status).toBe(308);
    expect(latest.headers.get('Location')).toBe('/demo/report/');
    const history = await apps.docsApp.request('/demo/report?sha=abcdef1');
    expect(history.status).toBe(308);
    expect(history.headers.get('Location')).toBe('/demo/report/_history/abcdef1/');
  });

  it('serves local mermaid build', async () => {
    const res = await apps.docsApp.request('/vendor/mermaid.min.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/javascript');
    expect(await res.text()).toContain('mermaid');
  });

  it('404s unknown sha', async () => {
    expect((await apps.docsApp.request(`/demo/report/_history/${'0'.repeat(40)}/`)).status).toBe(404);
  });

  it('serves historical version by sha', async () => {
    const versions = await (await apps.api.request('/api/docs/report/versions')).json();
    const form = new FormData();
    form.append('file', new File(['<p>v2</p>'], 'report.html', { type: 'text/html' }));
    form.append('project', 'demo');
    await apps.api.request('/api/docs', { method: 'POST', body: form });
    const res = await apps.docsApp.request(`/demo/report/_history/${versions[0].sha}/`);
    expect(await res.text()).toBe('<p>v1</p>');
    expect(await (await apps.docsApp.request('/demo/report/')).text()).toBe('<p>v2</p>');
  });

  it('serves rendered Markdown as HTML', async () => {
    const form = new FormData();
    form.append('file', new File(['# Markdown'], 'notes.md', { type: 'text/markdown' }));
    form.append('project', 'demo');
    await apps.api.request('/api/docs', { method: 'POST', body: form });
    const res = await apps.docsApp.request('/demo/notes/');
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

    const latest = await (await apps.docsApp.request('/demo/live-doc/')).text();
    const historical = await (await apps.docsApp.request(`/demo/live-doc/_history/${versions[0].sha}/`)).text();
    expect(latest).toContain('<title>Current</title>');
    expect(latest).toContain("postMessage({ type: 'agentdocs:navigate'");
    expect(historical).toContain('<title>Original</title>');
    expect(readFileSync(htmlFile, 'utf8')).toBe(committedHtml);
  });

  it('serves current and historical bundle assets with extension-derived headers', async () => {
    const upload = async (image: Uint8Array) => {
      const form = new FormData();
      form.append('file', new File(['<link rel="stylesheet" href="styles.css"><img src="assets/panel.png">'], 'bundle.html'));
      form.append('project', 'demo');
      form.append('title', 'Bundle');
      const companions = [
        ['styles.css', new TextEncoder().encode('body{}')],
        ['data.json', new TextEncoder().encode('{}')],
        ['assets/panel.png', image],
        ['assets/photo.jpg', new Uint8Array([4])],
        ['assets/photo.jpeg', new Uint8Array([5])],
        ['assets/panel.webp', new Uint8Array([6])],
        ['assets/anim.gif', new Uint8Array([7])],
      ] as const;
      const files = companions.map(([assetPath, bytes], index) => {
        form.append(`asset_${index}`, new File([bytes], path.basename(assetPath)));
        return { field: `asset_${index}`, path: assetPath, size: bytes.byteLength };
      });
      form.append('bundle_manifest', JSON.stringify({ version: 1, files }));
      return apps.api.request('/api/docs', { method: 'POST', body: form });
    };

    expect((await upload(new Uint8Array([0, 255, 128, 10]))).status).toBe(201);
    const versions = await (await apps.api.request('/api/docs/bundle/versions')).json();
    expect((await upload(new Uint8Array([254, 0, 129]))).status).toBe(200);

    for (const [assetPath, contentType] of [
      ['styles.css', 'text/css; charset=utf-8'],
      ['data.json', 'application/json; charset=utf-8'],
      ['assets/panel.png', 'image/png'],
      ['assets/photo.jpg', 'image/jpeg'],
      ['assets/photo.jpeg', 'image/jpeg'],
      ['assets/panel.webp', 'image/webp'],
      ['assets/anim.gif', 'image/gif'],
    ]) {
      const res = await apps.docsApp.request(`/demo/bundle/${assetPath}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe(contentType);
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    }
    expect(new Uint8Array(await (await apps.docsApp.request('/demo/bundle/assets/panel.png')).arrayBuffer())).toEqual(new Uint8Array([254, 0, 129]));
    const historical = await apps.docsApp.request(`/demo/bundle/_history/${versions[0].sha}/assets/panel.png`);
    expect(new Uint8Array(await historical.arrayBuffer())).toEqual(new Uint8Array([0, 255, 128, 10]));
    expect((await apps.docsApp.request('/demo/bundle/source.html')).status).toBe(404);
    expect((await apps.docsApp.request('/demo/bundle/meta.yaml')).status).toBe(404);

    const secret = path.join(dir, 'secret.png');
    writeFileSync(secret, new Uint8Array([9, 9, 9]));
    symlinkSync(secret, path.join(dir, 'docs/demo/bundle/bundle/escape.png'));
    expect((await apps.docsApp.request('/demo/bundle/escape.png')).status).toBe(404);
  });
});
