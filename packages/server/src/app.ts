import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { bodyLimit } from 'hono/body-limit';
import { execa } from 'execa';
import { parse as parseYaml, stringify as toYaml } from 'yaml';
import { parse as parseToml, stringify as toToml } from 'smol-toml';
import { loadConfig, type VaultConfig } from './config.js';
import { clearDocs, getDoc, listDocs, needsUpdatedBackfill, openDb, setFavorite, upsertDoc, type Db } from './db.js';
import { BundleInputError, MAX_BUNDLE_REQUEST_BYTES, bundleContentType, parseBundleFiles, validateBundlePath } from './bundles.js';
import { defaultDocumentRenderers, DocumentInputError, type DocumentRendererRegistry, titleFromFilename } from './documents.js';
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
  documentRenderers?: DocumentRendererRegistry;
}

function fieldValues(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value === undefined ? [] : [value];
}

function textField(body: Record<string, unknown>, key: string) {
  const value = fieldValues(body[key])[0];
  return typeof value === 'string' ? value : undefined;
}

function replaceBundleDirectory(bundleDir: string, stagedBundle: string | null) {
  let backup: string | null = null;
  if (existsSync(bundleDir)) {
    backup = mkdtempSync(`${bundleDir}-backup-`);
    rmSync(backup, { recursive: true });
    renameSync(bundleDir, backup);
  }
  try {
    if (stagedBundle) renameSync(stagedBundle, bundleDir);
  } catch (error) {
    if (backup) renameSync(backup, bundleDir);
    throw error;
  }
  if (backup) rmSync(backup, { recursive: true });
}

export async function createApps(vaultDir: string, hooks: Hooks = {}): Promise<Apps> {
  await ensureVault(vaultDir);
  const config = loadConfig(vaultDir);
  const db = openDb(path.join(vaultDir, 'index.db'));
  const documentRenderers = hooks.documentRenderers ?? defaultDocumentRenderers;

  function slugTakenOutside(slug: string, project: string) {
    const root = path.join(vaultDir, 'docs');
    return readdirSync(root).some(p => p !== project && existsSync(path.join(root, p, slug)));
  }

  function readMeta(project: string, slug: string): Record<string, any> | null {
    const f = path.join(vaultDir, 'docs', project, slug, 'meta.yaml');
    return existsSync(f) ? parseYaml(readFileSync(f, 'utf8')) : null;
  }

  function renderLatest(project: string, slug: string) {
    const dir = path.join(vaultDir, 'docs', project, slug);
    const meta = readMeta(project, slug);
    if (meta?.type === 'agentdoc' && typeof meta.source_file === 'string' && /^source\.[a-z0-9]+$/i.test(meta.source_file)) {
      const sourceFile = path.join(dir, meta.source_file);
      if (!existsSync(sourceFile)) throw new DocumentInputError('AgentDoc source is missing', 422);
      return documentRenderers.render(meta.source_file, readFileSync(sourceFile, 'utf8'), String(meta.title || slug), 'agentdoc');
    }
    return { html: readFileSync(path.join(dir, 'index.html'), 'utf8') };
  }

  async function docVersions(project: string, slug: string) {
    const { stdout } = await git(vaultDir, ['log', '--format=%H%x1f%aI%x1f%s', '--', `docs/${project}/${slug}`]);
    return stdout.split('\n').filter(Boolean).map(line => {
      const [sha, date, ...msg] = line.split('\x1f');
      return { sha, date, message: msg.join('\x1f') };
    });
  }

  async function indexDoc(project: string, slug: string, title: string, created: string, updated: string, html: string) {
    const versions = await docVersions(project, slug);
    upsertDoc(db, { slug, project, title, created, updated, body: stripHtml(html), latestSha: versions[0]?.sha ?? null });
  }

  const api = new Hono();

  api.get('/api/config', c => c.json({ docsPort: config.docsPort }));

  api.get('/api/settings', async c => {
    const gitConfig = async (key: string) =>
      git(vaultDir, ['config', key]).then(r => r.stdout.trim(), () => '');
    const cfg = loadConfig(vaultDir);
    return c.json({
      vaultDir,
      defaultProject: cfg.defaultProject,
      collapseAfter: cfg.collapseAfter,
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

    if (body.collapseAfter !== undefined) {
      const n = Number(body.collapseAfter);
      if (!Number.isInteger(n) || n < 1) {
        return c.json({ error: 'collapseAfter must be a positive integer' }, 400);
      }
      const file = path.join(vaultDir, 'vault.toml');
      const cfg: any = existsSync(file) ? parseToml(readFileSync(file, 'utf8')) : {};
      cfg.ui = { ...(cfg.ui as object), collapse_after: n };
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

  api.post('/api/docs', bodyLimit({
    maxSize: MAX_BUNDLE_REQUEST_BYTES,
    onError: c => c.json({ error: `multipart request exceeds ${MAX_BUNDLE_REQUEST_BYTES} bytes` }, 413),
  }), async c => {
    let body: Awaited<ReturnType<typeof c.req.parseBody>>;
    try {
      body = await c.req.parseBody({ all: true });
    } catch {
      return c.json({ error: 'invalid multipart form data' }, 400);
    }
    const files = fieldValues(body['file']);
    if (files.length !== 1 || !(files[0] instanceof File)) {
      return c.json({ error: 'multipart field "file" required exactly once' }, 400);
    }
    const file = files[0];
    let bundleFiles;
    try {
      bundleFiles = await parseBundleFiles(body, file.name);
    } catch (error) {
      if (error instanceof BundleInputError) return c.json({ error: error.message }, error.status);
      throw error;
    }

    const project = slugify(textField(body, 'project') || loadConfig(vaultDir).defaultProject);
    const fallbackTitle = textField(body, 'title') || titleFromFilename(file.name);
    let source: string;
    try {
      source = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
    } catch {
      return c.json({ error: 'document must be valid UTF-8 text' }, 422);
    }
    let rendered;
    try {
      rendered = documentRenderers.render(file.name, source, fallbackTitle, textField(body, 'type'));
    } catch (error) {
      if (error instanceof DocumentInputError) return c.json({ error: error.message }, error.status);
      throw error;
    }

    const title = rendered.title ?? fallbackTitle;
    let slug = rendered.id ?? slugify(title);
    let dir = path.join(vaultDir, 'docs', project, slug);
    const isUpdate = existsSync(dir);
    if (!isUpdate) {
      const base = slug;
      let n = 2;
      if (rendered.id && slugTakenOutside(slug, project)) {
        return c.json({ error: `document ID "${slug}" already exists in another project` }, 409);
      }
      while (slugTakenOutside(slug, project)) slug = `${base}-${n++}`;
      dir = path.join(vaultDir, 'docs', project, slug);
    }
    const previousMeta = isUpdate ? readMeta(project, slug) : null;
    const projectDir = path.join(vaultDir, 'docs', project);
    mkdirSync(projectDir, { recursive: true });
    let stagedBundle: string | null = null;
    if (bundleFiles !== null) {
      stagedBundle = mkdtempSync(path.join(projectDir, `.${slug}-bundle-`));
      try {
        for (const companion of bundleFiles) {
          const destination = path.resolve(stagedBundle, companion.path);
          if (!destination.startsWith(path.resolve(stagedBundle) + path.sep)) {
            throw new BundleInputError(`unsafe bundle path: ${companion.path}`, 400);
          }
          mkdirSync(path.dirname(destination), { recursive: true });
          writeFileSync(destination, companion.bytes);
        }
      } catch (error) {
        rmSync(stagedBundle, { recursive: true, force: true });
        if (error instanceof BundleInputError) return c.json({ error: error.message }, error.status);
        throw error;
      }
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'index.html'), rendered.html);
    writeFileSync(path.join(dir, rendered.sourceFile), source);
    const previousSource = previousMeta?.source_file;
    if (typeof previousSource === 'string' && previousSource !== rendered.sourceFile && /^source\.[a-z0-9]+$/i.test(previousSource)) {
      const oldSource = path.join(dir, previousSource);
      if (existsSync(oldSource)) unlinkSync(oldSource);
    }

    const created = (isUpdate && previousMeta?.created) || new Date().toISOString();
    let updated = (isUpdate && previousMeta?.updated) || created;
    const meta: Record<string, unknown> = {
      title,
      created,
      updated,
      type: rendered.type,
      source_file: rendered.sourceFile,
    };
    if (rendered.id) meta.document_id = rendered.id;
    if (rendered.schema) meta.schema = rendered.schema;
    if (bundleFiles !== null) {
      meta.bundle = true;
      meta.bundle_file_count = bundleFiles.length;
      meta.bundle_bytes = bundleFiles.reduce((total, companion) => total + companion.bytes.byteLength, 0);
    }
    for (const key of ['source', 'model', 'transcript'] as const) {
      const value = textField(body, key);
      if (value) meta[key] = value;
    }
    const sourceRepo = textField(body, 'source_repo');
    if (sourceRepo) {
      meta.source_repo_path = sourceRepo;
      try {
        const { stdout } = await execa('git', ['-C', sourceRepo, 'rev-parse', 'HEAD']);
        meta.source_repo_commit = stdout.trim();
      } catch { /* not a git repo — schema field left empty */ }
    }
    writeFileSync(path.join(dir, 'meta.yaml'), toYaml(meta));
    const bundleDir = path.join(dir, 'bundle');
    replaceBundleDirectory(bundleDir, stagedBundle);
    stagedBundle = null;

    const versions = await docVersions(project, slug);
    const subject = isUpdate ? `Update ${project}/${slug} (v${versions.length + 1})` : `Add ${project}/${slug}`;
    const details = [
      meta.model && `Model: ${meta.model}`,
      meta.transcript && `Transcript: ${meta.transcript}`,
    ].filter(Boolean).join('\n');
    const documentPath = `docs/${project}/${slug}`;
    await git(vaultDir, ['add', documentPath]);
    const stagedDiff = await execa('git', ['diff', '--cached', '--quiet', '--', documentPath], {
      cwd: vaultDir,
      reject: false,
    });
    if (stagedDiff.exitCode === 1) {
      if (isUpdate) {
        updated = new Date().toISOString();
        meta.updated = updated;
        writeFileSync(path.join(dir, 'meta.yaml'), toYaml(meta));
        await git(vaultDir, ['add', documentPath]);
      }
      await git(vaultDir, ['commit', '-m', details ? `${subject}\n\n${details}` : subject]);
      // Own commit — sync the watcher so pollHead doesn't fire a full reindex
      lastSha = (await git(vaultDir, ['rev-parse', 'HEAD'])).stdout.trim();
    } else if (stagedDiff.exitCode !== 0) {
      throw new Error(`git diff failed with exit code ${stagedDiff.exitCode}`);
    }

    await indexDoc(project, slug, title, created, updated, rendered.html);
    return c.json({
      slug, project, title, created, updated, type: rendered.type, update: isUpdate,
      ...(rendered.warnings?.length ? { warnings: rendered.warnings } : {}),
    }, isUpdate ? 200 : 201);
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
    const documentDir = `docs/${doc.project}/${doc.slug}`;
    const { stdout } = await git(vaultDir, [
      'diff', from, to, '--',
      `${documentDir}/source.agentdoc`,
      `${documentDir}/source.md`,
      `${documentDir}/source.html`,
    ]);
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
        let rendered: { html: string; title?: string };
        try {
          rendered = renderLatest(project, slug);
        } catch {
          rendered = { html: readFileSync(htmlFile, 'utf8') };
        }
        rows.push({
          slug, project,
          title: rendered.title ?? meta?.title ?? slug,
          created: meta?.created ?? '',
          updated: meta?.updated ?? versions[0]?.date ?? meta?.created ?? '',
          body: stripHtml(rendered.html),
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

  if (needsUpdatedBackfill(db)) await reindexVault();

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
    'Content-Security-Policy': "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src data:",
    'X-Content-Type-Options': 'nosniff',
  };
  const ASSET_HEADERS = {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
  const VIEWER_BRIDGE = `<script>
(() => {
  const report = () => {
    const max = Math.max(0, document.documentElement.scrollHeight - innerHeight);
    parent.postMessage({ type: 'agentdocs:scroll', ratio: max ? scrollY / max : 0 }, '*');
  };
  addEventListener('scroll', report, { passive: true });
  addEventListener('message', event => {
    if (event.source !== parent || event.data?.type !== 'agentdocs:restore-scroll') return;
    const ratio = Number(event.data.ratio);
    if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) return;
    requestAnimationFrame(() => {
      const max = Math.max(0, document.documentElement.scrollHeight - innerHeight);
      scrollTo(0, ratio * max);
    });
  });
})();
</script>`;

  function documentResponseHtml(html: string, viewer: boolean) {
    if (!viewer) return html;
    const bodyEnd = html.search(/<\/body\s*>/i);
    return bodyEnd === -1 ? html + VIEWER_BRIDGE : html.slice(0, bodyEnd) + VIEWER_BRIDGE + html.slice(bodyEnd);
  }

  function validDocumentPath(project: string, slug: string) {
    return /^[a-z0-9-]+$/.test(project) && /^[a-z0-9-]+$/.test(slug);
  }

  async function historicalAsset(project: string, slug: string, sha: string, relativePath: string) {
    const { stdout } = await execa('git', ['show', `${sha}:docs/${project}/${slug}/bundle/${relativePath}`], {
      cwd: vaultDir,
      encoding: 'buffer',
      stripFinalNewline: false,
    });
    return new Uint8Array(stdout);
  }

  // Local Mermaid build — docs' CSP blocks CDN scripts, so serve it same-origin
  const mermaidJs = readFileSync(createRequire(import.meta.url).resolve('mermaid/dist/mermaid.min.js'));
  docsApp.get('/vendor/mermaid.min.js', () => new Response(mermaidJs, {
    headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=3600' },
  }));

  docsApp.get('/:project/:slug', c => {
    const { project, slug } = c.req.param();
    if (!validDocumentPath(project, slug)) return c.notFound();
    const requestUrl = new URL(c.req.url);
    if (requestUrl.searchParams.has('sha')) {
      const sha = requestUrl.searchParams.get('sha') ?? '';
      if (!/^[0-9a-f]{7,40}$/i.test(sha)) return c.text('bad sha', 400);
      return c.redirect(`/${project}/${slug}/_history/${sha}/`, 308);
    }
    return c.redirect(`/${project}/${slug}/`, 308);
  });

  docsApp.get('/:project/:slug/', c => {
    const { project, slug } = c.req.param();
    if (!validDocumentPath(project, slug)) return c.notFound();
    const f = path.join(vaultDir, 'docs', project, slug, 'index.html');
    if (!existsSync(f)) return c.notFound();
    let html: string;
    try {
      html = renderLatest(project, slug).html;
    } catch (error) {
      if (error instanceof DocumentInputError) return c.text(error.message, error.status);
      throw error;
    }
    return new Response(documentResponseHtml(html, c.req.query('viewer') === '1'), { headers: { ...DOC_HEADERS } });
  });

  docsApp.get('/:project/:slug/_history/:sha/', async c => {
    const { project, slug, sha } = c.req.param();
    if (!validDocumentPath(project, slug)) return c.notFound();
    if (!/^[0-9a-f]{7,40}$/i.test(sha)) return c.text('bad sha', 400);
    try {
      const { stdout } = await git(vaultDir, ['show', `${sha}:docs/${project}/${slug}/index.html`]);
      return new Response(documentResponseHtml(stdout, c.req.query('viewer') === '1'), { headers: { ...DOC_HEADERS } });
    } catch {
      return c.notFound();
    }
  });

  docsApp.get('/:project/:slug/_history/:sha/:asset{.+}', async c => {
    const { project, slug, sha } = c.req.param();
    const relativePath = c.req.param('asset');
    if (!validDocumentPath(project, slug) || !/^[0-9a-f]{7,40}$/i.test(sha)) return c.notFound();
    let contentType: string;
    try {
      contentType = bundleContentType(relativePath);
    } catch {
      return c.notFound();
    }
    try {
      const bytes = await historicalAsset(project, slug, sha, relativePath);
      return new Response(bytes, { headers: { ...ASSET_HEADERS, 'Content-Type': contentType } });
    } catch {
      return c.notFound();
    }
  });

  docsApp.get('/:project/:slug/:asset{.+}', c => {
    const { project, slug } = c.req.param();
    const relativePath = c.req.param('asset');
    if (!validDocumentPath(project, slug)) return c.notFound();
    let contentType: string;
    try {
      validateBundlePath(relativePath);
      contentType = bundleContentType(relativePath);
    } catch {
      return c.notFound();
    }
    const bundleRoot = path.resolve(vaultDir, 'docs', project, slug, 'bundle');
    const assetPath = path.resolve(bundleRoot, relativePath);
    if (!assetPath.startsWith(bundleRoot + path.sep) || !existsSync(bundleRoot) || !existsSync(assetPath)) return c.notFound();
    const rootStat = lstatSync(bundleRoot);
    const assetStat = lstatSync(assetPath);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory() || assetStat.isSymbolicLink() || !assetStat.isFile()) return c.notFound();
    const realBundleRoot = realpathSync(bundleRoot);
    const realAssetPath = realpathSync(assetPath);
    if (!realAssetPath.startsWith(realBundleRoot + path.sep)) return c.notFound();
    return new Response(readFileSync(assetPath), { headers: { ...ASSET_HEADERS, 'Content-Type': contentType } });
  });

  return { api, docsApp, config, db, reindex: reindexVault, stop: () => clearInterval(watchTimer) };
}
