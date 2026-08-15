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
  form.append('file', new File([html], name, { type: 'text/html' }));
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return apps.api.request('/api/docs', { method: 'POST', body: form });
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

  it('creates doc on disk, commits, indexes', async () => {
    const res = await postDoc({ project: 'demo', title: 'Report' });
    expect(res.status).toBe(201);
    expect(existsSync(path.join(dir, 'docs/demo/report/index.html'))).toBe(true);
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
