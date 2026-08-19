import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { execa } from 'execa';
import { parse as parseYaml, stringify as toYaml } from 'yaml';
import { parse as parseToml, stringify as toToml } from 'smol-toml';
import { loadConfig, type VaultConfig } from './config.js';
import { clearDocs, getDoc, listDocs, openDb, setFavorite, upsertDoc, type Db } from './db.js';
import { git } from './git.js';
import { saveVaultDir } from './settings.js';
import { ensureVault } from './vault.js';
import { slugify, stripHtml } from './util.js';

export interface Apps {
  api: Hono;
  docsApp: Hono;
  config: VaultConfig;
  db: Db;
  reindex: () => Promise<number>;
  stop: () => void;
}

export interface Hooks {
  onVaultDirChanged?: (dir: string) => Promise<void>;
}

export async function createApps(vaultDir: string, hooks: Hooks = {}): Promise<Apps> {
  await ensureVault(vaultDir);
  const config = loadConfig(vaultDir);
  const db = openDb(path.join(vaultDir, 'index.db'));

  function slugTakenOutside(slug: string, project: string) {
    const root = path.join(vaultDir, 'docs');
    return readdirSync(root).some(p => p !== project && existsSync(path.join(root, p, slug)));
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

  api.get('/api/settings', async c => {
    const gitConfig = async (key: string) =>
      git(vaultDir, ['config', key]).then(r => r.stdout.trim(), () => '');
    return c.json({
      vaultDir,
      defaultProject: loadConfig(vaultDir).defaultProject,
      gitUserName: await gitConfig('user.name'),
      gitUserEmail: await gitConfig('user.email'),
    });
  });

  api.post('/api/settings', async c => {
    // vaultDir swaps to a new vault; other fields still target THIS vault's
    // vault.toml/git config — clients changing vaultDir should send it alone.
    const body = await c.req.json();
    let swapped = false;

    if (body.vaultDir !== undefined) {
      const dir = path.resolve(String(body.vaultDir));
      if (existsSync(dir) && !statSync(dir).isDirectory()) {
        return c.json({ error: 'vaultDir exists and is not a directory' }, 400);
      }
      if (dir !== vaultDir) {
        saveVaultDir(dir);
        if (hooks.onVaultDirChanged) {
          await hooks.onVaultDirChanged(dir);
          swapped = true;
        }
      }
    }

    if (body.defaultProject !== undefined) {
      const project = slugify(String(body.defaultProject)) || 'misc';
      const file = path.join(vaultDir, 'vault.toml');
      const cfg: any = existsSync(file) ? parseToml(readFileSync(file, 'utf8')) : {};
      cfg.defaults = { ...(cfg.defaults as object), project };
      writeFileSync(file, toToml(cfg));
    }

    if (body.gitUserName !== undefined) {
      await git(vaultDir, ['config', 'user.name', String(body.gitUserName)]);
    }
    if (body.gitUserEmail !== undefined) {
      await git(vaultDir, ['config', 'user.email', String(body.gitUserEmail)]);
    }

    return c.json({ swapped });
  });

  api.post('/api/docs', async c => {
    const body = await c.req.parseBody();
    const file = body['file'];
    if (!(file instanceof File)) return c.json({ error: 'multipart field "file" required' }, 400);

    const project = slugify(String(body['project'] || loadConfig(vaultDir).defaultProject));
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
      // Own commit — sync the watcher so pollHead doesn't fire a full reindex
      lastSha = (await git(vaultDir, ['rev-parse', 'HEAD'])).stdout.trim();
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

  api.patch('/api/docs/:slug', async c => {
    const doc = getDoc(db, c.req.param('slug'));
    if (!doc) return c.json({ error: 'not found' }, 404);
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.favorite !== 'boolean') return c.json({ error: 'favorite (boolean) required' }, 400);
    setFavorite(db, doc.slug, body.favorite);
    return c.json({ slug: doc.slug, favorite: body.favorite });
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

  async function reindexVault() {
    const root = path.join(vaultDir, 'docs');
    const rows: (Parameters<typeof upsertDoc>[1])[] = [];
    for (const project of readdirSync(root)) {
      for (const slug of readdirSync(path.join(root, project))) {
        const htmlFile = path.join(root, project, slug, 'index.html');
        if (!existsSync(htmlFile)) continue;
        const meta = readMeta(project, slug);
        const versions = await docVersions(project, slug);
        rows.push({
          slug, project,
          title: meta?.title ?? slug,
          created: meta?.created ?? '',
          body: stripHtml(readFileSync(htmlFile, 'utf8')),
          latestSha: versions[0]?.sha ?? null,
        });
      }
    }
    // Atomic swap: slow git/file work happens above; the clear+reinsert is a
    // single sync transaction so readers never see a partial index
    db.transaction(() => {
      clearDocs(db);
      for (const row of rows) upsertDoc(db, row);
    })();
    return rows.length;
  }

  api.post('/api/reindex', async c => c.json({ indexed: await reindexVault() }));

  // Detect external commits (e.g. git push into the vault repo) and reindex.
  // Own commits (POST /api/docs) update lastSha directly so they don't trigger
  // a full reindex — the upload already indexed the doc itself.
  let lastSha: string | null = null;
  let pollBusy = false;
  const pollHead = async () => {
    if (pollBusy) return; // never stack overlapping git spawns
    pollBusy = true;
    try {
      const { stdout } = await git(vaultDir, ['rev-parse', 'HEAD']);
      const sha = stdout.trim();
      if (lastSha !== null && sha !== lastSha) await reindexVault();
      lastSha = sha;
    } catch { /* vault repo temporarily unreadable */ }
    finally { pollBusy = false; }
  };
  await pollHead();
  const watchTimer = setInterval(pollHead, 2000);
  watchTimer.unref?.();

  const webDist = process.env.WEB_DIST ?? path.join(import.meta.dirname, '..', 'web', 'dist');
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
    'Cache-Control': 'no-store',
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

  return { api, docsApp, config, db, reindex: reindexVault, stop: () => clearInterval(watchTimer) };
}
