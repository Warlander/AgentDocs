import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApps, type Apps } from '../src/app.js';
import { clearDocs } from '../src/db.js';

let dir: string;
let apps: Apps;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'api-test-'));
  apps = await createApps(dir);
});

afterEach(async () => {
  apps.stop();
  apps.db.close();
  await rm(dir, { recursive: true, force: true });
});

function postDoc(fields: Record<string, string>, html = '<p>hello</p>', name = 'report.html') {
  const form = new FormData();
  const mediaType = /\.md|\.markdown$/i.test(name) ? 'text/markdown' : 'text/html';
  form.append('file', new File([html], name, { type: mediaType }));
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return apps.api.request('/api/docs', { method: 'POST', body: form });
}

function agentDoc(title: string, id = 'agent-report') {
  return `@schema agentdocs/v1
@id ${id}
@title "${title}"
@kind specification
@description
This specification verifies AgentDoc integration. Its metadata comes from source.
@end-description
@evaluations
@evaluation metric=size level=0
The document is small.
@end-evaluation
@evaluation metric=complexity level=0
The implementation path is direct.
@end-evaluation
@evaluation metric=risk level=0
The behavior is isolated.
@end-evaluation
@end-evaluations`;
}

async function logCount(p: string) {
  const { stdout } = await execa('git', ['-C', dir, 'log', '--format=%H', '--', p]);
  return stdout.split('\n').filter(Boolean).length;
}

describe('POST /api/docs', () => {
  it('rejects multipart without file field', async () => {
    const form = new FormData();
    form.append('project', 'demo');
    const res = await apps.api.request('/api/docs', { method: 'POST', body: form });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('file');
  });

  it('rejects malformed multipart without returning 500', async () => {
    const res = await apps.api.request('/api/docs', {
      method: 'POST',
      headers: { 'Content-Type': 'multipart/form-data; boundary=broken' },
      body: '--broken\r\nnot-a-valid-part',
    });
    expect(res.status).toBe(400);
  });

  it('creates doc on disk, commits, indexes', async () => {
    const res = await postDoc({ project: 'demo', title: 'Report' });
    expect(res.status).toBe(201);
    expect(existsSync(path.join(dir, 'docs/demo/report/index.html'))).toBe(true);
    expect(existsSync(path.join(dir, 'docs/demo/report/source.html'))).toBe(true);
    expect(existsSync(path.join(dir, 'docs/demo/report/meta.yaml'))).toBe(true);
    const { stdout } = await execa('git', ['-C', dir, 'log', '-1', '--format=%s']);
    expect(stdout).toBe('Add demo/report');
    const list = await (await apps.api.request('/api/docs?q=revenue')).json();
    expect(Array.isArray(list)).toBe(true);
  });

  it('update keeps slug, bumps version, preserves created', async () => {
    const first = await (await postDoc({ project: 'demo', title: 'Report' })).json();
    const res = await postDoc({ project: 'demo', title: 'Report' }, '<p>changed</p>');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.update).toBe(true);
    expect(body.slug).toBe('report');
    expect(body.created).toBe(first.created);
    expect(await logCount('docs/demo/report')).toBe(2);
  });

  it('suffixes slug on cross-project collision', async () => {
    await postDoc({ project: 'demo', title: 'Report' });
    const body = await (await postDoc({ project: 'misc', title: 'Report' })).json();
    expect(body.slug).toBe('report-2');
  });

  it('defaults title to filename', async () => {
    const body = await (await postDoc({ project: 'demo' })).json();
    expect(body.title).toBe('report');
  });

  it('renders Markdown and preserves its source', async () => {
    const res = await postDoc({ project: 'demo' }, '# Revenue\n\n**Up**', 'report.md');
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ title: 'report', type: 'markdown' });
    expect(readFileSync(path.join(dir, 'docs/demo/report/source.md'), 'utf8')).toContain('# Revenue');
    expect(readFileSync(path.join(dir, 'docs/demo/report/index.html'), 'utf8')).toContain('<strong>Up</strong>');
    expect(readFileSync(path.join(dir, 'docs/demo/report/meta.yaml'), 'utf8')).toContain('type: markdown');
    clearDocs(apps.db);
    expect(await apps.reindex()).toBe(1);
    const found = await (await apps.api.request('/api/docs?q=revenue')).json();
    expect(found).toHaveLength(1);
  });

  it('uses AgentDoc source as canonical title and identity', async () => {
    const res = await postDoc({ project: 'demo', title: 'Ignored upload title' }, agentDoc('Canonical title'), 'arbitrary.agentdoc');
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ slug: 'agent-report', title: 'Canonical title', type: 'agentdoc' });
    expect(readFileSync(path.join(dir, 'docs/demo/agent-report/source.agentdoc'), 'utf8')).toContain('@title "Canonical title"');
    const meta = readFileSync(path.join(dir, 'docs/demo/agent-report/meta.yaml'), 'utf8');
    expect(meta).toContain('document_id: agent-report');
    expect(meta).toContain('schema: agentdocs/v1');
  });

  it('keeps one AgentDoc history when its title changes', async () => {
    await postDoc({ project: 'demo' }, agentDoc('First title'), 'one.agentdoc');
    const res = await postDoc({ project: 'demo' }, agentDoc('Renamed title'), 'two.agentdoc');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ slug: 'agent-report', title: 'Renamed title', update: true });
    expect(await logCount('docs/demo/agent-report')).toBe(2);
    const docs = await (await apps.api.request('/api/docs')).json();
    expect(docs).toHaveLength(1);
    expect(docs[0].title).toBe('Renamed title');
  });

  it('rejects globally conflicting AgentDoc IDs instead of changing them', async () => {
    await postDoc({ project: 'demo' }, agentDoc('First', 'shared-id'), 'one.agentdoc');
    const res = await postDoc({ project: 'other' }, agentDoc('Second', 'shared-id'), 'two.agentdoc');
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('already exists in another project');
    expect(existsSync(path.join(dir, 'docs/other/shared-id'))).toBe(false);
  });

  it('rejects invalid AgentDoc before persistence', async () => {
    const res = await postDoc({ project: 'demo' }, '@schema agentdocs/v1\n@id broken', 'broken.agentdoc');
    expect(res.status).toBe(422);
    expect(existsSync(path.join(dir, 'docs/demo/broken'))).toBe(false);
  });

  it('reindexes AgentDoc title and body from current source', async () => {
    await postDoc({ project: 'demo' }, agentDoc('Original title'), 'report.agentdoc');
    const sourceFile = path.join(dir, 'docs/demo/agent-report/source.agentdoc');
    writeFileSync(sourceFile, agentDoc('Source-only title').replace('AgentDoc integration', 'fresh searchable content'));
    clearDocs(apps.db);
    expect(await apps.reindex()).toBe(1);
    const found = await (await apps.api.request('/api/docs?q=searchable')).json();
    expect(found).toHaveLength(1);
    expect(found[0].title).toBe('Source-only title');
  });

  it('returns 415 for unsupported document types without persisting', async () => {
    const res = await postDoc({ project: 'demo' }, 'plain text', 'report.txt');
    expect(res.status).toBe(415);
    expect(await res.json()).toEqual({ error: 'unsupported file extension ".txt"' });
    expect(existsSync(path.join(dir, 'docs/demo'))).toBe(false);
    expect(await (await apps.api.request('/api/docs')).json()).toHaveLength(0);
  });

  it('returns 422 for invalid UTF-8 without persisting', async () => {
    const form = new FormData();
    form.append('file', new File([new Uint8Array([0xff])], 'report.md', { type: 'text/markdown' }));
    form.append('project', 'demo');
    const res = await apps.api.request('/api/docs', { method: 'POST', body: form });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'document must be valid UTF-8 text' });
    expect(existsSync(path.join(dir, 'docs/demo'))).toBe(false);
  });

  it('leaves an existing document unchanged after an invalid update', async () => {
    await postDoc({ project: 'demo', title: 'Report' }, '<p>valid</p>');
    const before = readFileSync(path.join(dir, 'docs/demo/report/index.html'), 'utf8');
    const res = await postDoc({ project: 'demo', title: 'Report' }, '', 'report.html');
    expect(res.status).toBe(422);
    expect(readFileSync(path.join(dir, 'docs/demo/report/index.html'), 'utf8')).toBe(before);
    expect(await logCount('docs/demo/report')).toBe(1);
  });

  it('replaces the managed source when an update changes type', async () => {
    await postDoc({ project: 'demo', title: 'Report' }, '<p>HTML</p>');
    const res = await postDoc({ project: 'demo', title: 'Report' }, '# Markdown', 'report.md');
    expect(res.status).toBe(200);
    expect(existsSync(path.join(dir, 'docs/demo/report/source.html'))).toBe(false);
    expect(existsSync(path.join(dir, 'docs/demo/report/source.md'))).toBe(true);
    expect(readFileSync(path.join(dir, 'docs/demo/report/meta.yaml'), 'utf8')).toContain('type: markdown');
  });

  it('defaults project from config', async () => {
    const body = await (await postDoc({ title: 'X' })).json();
    expect(body.project).toBe('misc');
  });

  it('source_repo without git leaves commit field empty', async () => {
    const plain = await mkdtemp(path.join(tmpdir(), 'plain-'));
    const res = await postDoc({ project: 'demo', title: 'S', source_repo: plain });
    expect(res.status).toBe(201);
    const meta = readFileSync(path.join(dir, 'docs/demo/s/meta.yaml'), 'utf8');
    expect(meta).toContain('source_repo_path');
    expect(meta).not.toContain('source_repo_commit');
    await rm(plain, { recursive: true, force: true });
  });

  it('source_repo with git records HEAD commit', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'repo-'));
    await execa('git', ['-C', repo, 'init']);
    await execa('git', ['-C', repo, 'config', 'user.email', 't@t']);
    await execa('git', ['-C', repo, 'config', 'user.name', 'T']);
    await execa('git', ['-C', repo, 'commit', '--allow-empty', '-m', 'x']);
    const { stdout: head } = await execa('git', ['-C', repo, 'rev-parse', 'HEAD']);
    await postDoc({ project: 'demo', title: 'G', source_repo: repo });
    const meta = readFileSync(path.join(dir, 'docs/demo/g/meta.yaml'), 'utf8');
    expect(meta).toContain(head.trim());
    await rm(repo, { recursive: true, force: true });
  });

  it('identical re-upload does not create a commit', async () => {
    await postDoc({ project: 'demo', title: 'Same' });
    const res = await postDoc({ project: 'demo', title: 'Same' });
    expect(res.status).toBe(200);
    expect(await logCount('docs/demo/same')).toBe(1);
  });
});

describe('read endpoints', () => {
  beforeEach(async () => {
    await postDoc({ project: 'demo', title: 'Report' }, '<p>v1 revenue</p>');
    await postDoc({ project: 'demo', title: 'Report' }, '<p>v2 revenue</p>');
  });

  it('gets doc with meta', async () => {
    const res = await apps.api.request('/api/docs/report');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.slug).toBe('report');
    expect(body.meta.title).toBe('Report');
  });

  it('404s unknown slug', async () => {
    expect((await apps.api.request('/api/docs/ghost')).status).toBe(404);
  });

  it('lists versions newest first', async () => {
    const versions = await (await apps.api.request('/api/docs/report/versions')).json();
    expect(versions).toHaveLength(2);
    const { stdout: head } = await execa('git', ['-C', dir, 'rev-parse', 'HEAD']);
    expect(versions[0].sha).toBe(head.trim());
  });

  it('diffs two versions', async () => {
    const versions = await (await apps.api.request('/api/docs/report/versions')).json();
    const res = await apps.api.request(`/api/docs/report/diff?from=${versions[1].sha}&to=${versions[0].sha}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('v2 revenue');
  });

  it('rejects malformed SHAs before reaching git', async () => {
    expect((await apps.api.request('/api/docs/report/diff?from=abc!%40%23&to=def4567')).status).toBe(400);
    expect((await apps.api.request('/api/docs/report/diff?from=$(touch%20x)&to=def4567')).status).toBe(400);
  });

  it('rejects missing diff params', async () => {
    expect((await apps.api.request('/api/docs/report/diff')).status).toBe(400);
  });

  it('reindex rebuilds search index', async () => {
    clearDocs(apps.db);
    expect(await (await apps.api.request('/api/docs')).json()).toHaveLength(0);
    const res = await apps.api.request('/api/reindex', { method: 'POST' });
    expect(await res.json()).toEqual({ indexed: 1 });
    const found = await (await apps.api.request('/api/docs?q=revenue')).json();
    expect(found).toHaveLength(1);
  });
});

describe('PATCH /api/docs/:slug', () => {
  const patch = (slug: string, body: unknown) =>
    apps.api.request(`/api/docs/${slug}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  beforeEach(async () => {
    await postDoc({ project: 'demo', title: 'Report' });
  });

  it('toggles favorite on and off', async () => {
    const res = await patch('report', { favorite: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ slug: 'report', favorite: true });

    const list = await (await apps.api.request('/api/docs')).json();
    expect(list[0].favorite).toBe(true);

    await patch('report', { favorite: false });
    const after = await (await apps.api.request('/api/docs')).json();
    expect(after[0].favorite).toBe(false);
  });

  it('favorite survives reindex', async () => {
    await patch('report', { favorite: true });
    await apps.reindex();
    const list = await (await apps.api.request('/api/docs')).json();
    expect(list[0].favorite).toBe(true);
  });

  it('404s unknown slug', async () => {
    expect((await patch('ghost', { favorite: true })).status).toBe(404);
  });

  it('400s when favorite is not a boolean', async () => {
    expect((await patch('report', {})).status).toBe(400);
    expect((await patch('report', { favorite: 'yes' })).status).toBe(400);
  });
});

describe('vault watcher', () => {
  it('reindexes after an external commit', async () => {
    await postDoc({ project: 'demo', title: 'Report' });
    writeFileSync(path.join(dir, 'docs/demo/report/index.html'), '<p>external</p>');
    await execa('git', ['-C', dir, 'add', '.']);
    await execa('git', ['-C', dir, 'commit', '-m', 'external update']);
    const deadline = Date.now() + 8000;
    let found: unknown[] = [];
    while (Date.now() < deadline) {
      found = await (await apps.api.request('/api/docs?q=external')).json();
      if (found.length) return;
      await new Promise(r => setTimeout(r, 300));
    }
    expect(found).toHaveLength(1);
  }, 10000);
});
