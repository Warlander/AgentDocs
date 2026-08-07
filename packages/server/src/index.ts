import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { execa } from 'execa';
import { parse as parseYaml, stringify as toYaml } from 'yaml';
import { loadConfig } from './config.js';
import { clearDocs, getDoc, listDocs, openDb, upsertDoc } from './db.js';
import { git } from './git.js';
import { ensureVault } from './vault.js';

const vaultDir = path.resolve(
  process.env.VAULT_DIR ?? path.join(import.meta.dirname, '..', '..', '..', 'vault'),
);
await ensureVault(vaultDir);
const config = loadConfig(vaultDir);
const db = openDb(path.join(vaultDir, 'index.db'));
const host = process.env.HOST ?? '127.0.0.1';

function slugify(s: string) {
  return s.toLowerCase().replace(/\.html?$/i, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'doc';
}

function slugTakenOutside(slug: string, project: string) {
  const root = path.join(vaultDir, 'docs');
  return readdirSync(root).some(p => p !== project && existsSync(path.join(root, p, slug)));
}

function stripHtml(html: string) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function readMeta(project: string, slug: string): Record<string, any> | null {
  const f = path.join(vaultDir, 'docs', project, slug, 'meta.yaml');
  return existsSync(f) ? parseYaml(readFileSync(f, 'utf8')) : null;
}

async function docVersions(project: string, slug: string) {
  const { stdout } = await git(vaultDir, ['log', '--format=%H%x1f%aI%x1f%s', '--', `docs/${project}/${slug}`]);
  return stdout.split('\n').filter(Boolean).map(line => {
    const [sha, date, ...msg] = line.split('\x1f');
    return { sha, date, message: msg.join('\x1f') };
  });
}

async function indexDoc(project: string, slug: string, title: string, created: string, html: string) {
  const versions = await docVersions(project, slug);
  upsertDoc(db, { slug, project, title, created, body: stripHtml(html), latestSha: versions[0]?.sha ?? null });
}

const api = new Hono();

api.get('/api/config', c => c.json({ docsPort: config.docsPort }));

api.post('/api/docs', async c => {
  const body = await c.req.parseBody();
  const file = body['file'];
  if (!(file instanceof File)) return c.json({ error: 'multipart field "file" required' }, 400);

  const project = slugify(String(body['project'] || config.defaultProject));
  const title = String(body['title'] || file.name.replace(/\.html?$/i, ''));
  let slug = slugify(title);
  const html = await file.text();

  let dir = path.join(vaultDir, 'docs', project, slug);
  const isUpdate = existsSync(dir);
  if (!isUpdate) {
    const base = slug;
    let n = 2;
    while (slugTakenOutside(slug, project)) slug = `${base}-${n++}`;
    dir = path.join(vaultDir, 'docs', project, slug);
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'index.html'), html);

  const created = (isUpdate && readMeta(project, slug)?.created) || new Date().toISOString();
  const meta: Record<string, unknown> = { title, created };
  for (const key of ['source', 'model', 'transcript'] as const) {
    if (body[key]) meta[key] = String(body[key]);
  }
  if (body['source_repo']) {
    meta.source_repo_path = String(body['source_repo']);
    try {
      const { stdout } = await execa('git', ['-C', String(body['source_repo']), 'rev-parse', 'HEAD']);
      meta.source_repo_commit = stdout.trim();
    } catch { /* not a git repo — schema field left empty */ }
  }
  writeFileSync(path.join(dir, 'meta.yaml'), toYaml(meta));

  const versions = await docVersions(project, slug);
  const subject = isUpdate ? `Update ${project}/${slug} (v${versions.length + 1})` : `Add ${project}/${slug}`;
  const details = [
    meta.model && `Model: ${meta.model}`,
    meta.transcript && `Transcript: ${meta.transcript}`,
  ].filter(Boolean).join('\n');
  await git(vaultDir, ['add', `docs/${project}/${slug}`]);
  try {
    await git(vaultDir, ['commit', '-m', details ? `${subject}\n\n${details}` : subject]);
  } catch { /* identical re-upload — nothing to commit */ }

  await indexDoc(project, slug, title, created, html);
  return c.json({ slug, project, title, created, update: isUpdate }, isUpdate ? 200 : 201);
});

api.get('/api/docs', c =>
  c.json(listDocs(db, c.req.query('q') || undefined, c.req.query('project') || undefined)));

api.get('/api/docs/:slug', c => {
  const doc = getDoc(db, c.req.param('slug'));
  if (!doc) return c.json({ error: 'not found' }, 404);
  return c.json({ ...doc, meta: readMeta(doc.project, doc.slug) ?? {} });
});

api.get('/api/docs/:slug/versions', async c => {
  const doc = getDoc(db, c.req.param('slug'));
  if (!doc) return c.json({ error: 'not found' }, 404);
  return c.json(await docVersions(doc.project, doc.slug));
});

api.get('/api/docs/:slug/diff', async c => {
  const doc = getDoc(db, c.req.param('slug'));
  if (!doc) return c.json({ error: 'not found' }, 404);
  const from = c.req.query('from') ?? '';
  const to = c.req.query('to') ?? '';
  if (!/^[0-9a-f]{7,40}$/i.test(from) || !/^[0-9a-f]{7,40}$/i.test(to)) {
    return c.json({ error: 'from/to must be commit SHAs' }, 400);
  }
  const { stdout } = await git(vaultDir, ['diff', from, to, '--', `docs/${doc.project}/${doc.slug}/index.html`]);
  return c.text(stdout);
});

api.post('/api/reindex', async c => {
  clearDocs(db);
  let count = 0;
  const root = path.join(vaultDir, 'docs');
  for (const project of readdirSync(root)) {
    for (const slug of readdirSync(path.join(root, project))) {
      const htmlFile = path.join(root, project, slug, 'index.html');
      if (!existsSync(htmlFile)) continue;
      const meta = readMeta(project, slug);
      await indexDoc(project, slug, meta?.title ?? slug, meta?.created ?? '', readFileSync(htmlFile, 'utf8'));
      count++;
    }
  }
  return c.json({ indexed: count });
});

const webDist = process.env.WEB_DIST ?? path.join(import.meta.dirname, '..', '..', 'web', 'dist');
if (existsSync(webDist)) {
  api.use('/*', serveStatic({ root: webDist }));
  api.notFound(c => {
    if (c.req.path.startsWith('/api/')) return c.json({ error: 'not found' }, 404);
    return c.html(readFileSync(path.join(webDist, 'index.html'), 'utf8'));
  });
}

const docsApp = new Hono();
const DOC_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; font-src data:",
  'X-Content-Type-Options': 'nosniff',
};

docsApp.get('/:project/:slug', async c => {
  const { project, slug } = c.req.param();
  if (!/^[a-z0-9-]+$/.test(project) || !/^[a-z0-9-]+$/.test(slug)) return c.notFound();
  const sha = c.req.query('sha');
  let html: string;
  if (sha) {
    if (!/^[0-9a-f]{7,40}$/i.test(sha)) return c.text('bad sha', 400);
    try {
      ({ stdout: html } = await git(vaultDir, ['show', `${sha}:docs/${project}/${slug}/index.html`]));
    } catch {
      return c.notFound();
    }
  } else {
    const f = path.join(vaultDir, 'docs', project, slug, 'index.html');
    if (!existsSync(f)) return c.notFound();
    html = readFileSync(f, 'utf8');
  }
  return new Response(html, { headers: { ...DOC_HEADERS } });
});

serve({ fetch: api.fetch, port: config.apiPort, hostname: host });
serve({ fetch: docsApp.fetch, port: config.docsPort, hostname: host });
const displayHost = host === '0.0.0.0' ? 'localhost' : host;
console.log(`API + UI  http://${displayHost}:${config.apiPort}`);
console.log(`Docs      http://${displayHost}:${config.docsPort}  (vault: ${vaultDir})`);
