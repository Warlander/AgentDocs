#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { basename, extname, join, relative, sep } from 'node:path';
import { Command } from 'commander';

const BASE = (process.env.VAULT_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const PRIMARY_EXTENSIONS = new Set(['.html', '.htm', '.md', '.markdown', '.agentdoc']);
const COMPANION_TYPES: Readonly<Record<string, string>> = {
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};
const MAX_BUNDLE_FILES = 256;
const MAX_BUNDLE_FILE_BYTES = 25 * 1024 * 1024;
const MAX_BUNDLE_PATH_LENGTH = 512;
const MAX_BUNDLE_SEGMENT_LENGTH = 128;

interface CompanionFile { absolutePath: string; path: string; size: number }

function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function mediaType(file: string) {
  const extension = extname(file).toLowerCase();
  return ['.md', '.markdown'].includes(extension)
    ? 'text/markdown'
    : extension === '.agentdoc'
      ? 'application/vnd.agentdocs+text'
      : 'text/html';
}

function validateBundlePath(file: string) {
  if (file.length === 0 || file.length > MAX_BUNDLE_PATH_LENGTH || file.includes('\\') || /[\0-\x1f\x7f?#]/.test(file)) {
    fail(`unsafe bundle path: ${file}`);
  }
  const segments = file.split('/');
  if (segments[0].toLowerCase() === '_history' || segments.some(segment =>
    segment.length === 0 ||
    segment.length > MAX_BUNDLE_SEGMENT_LENGTH ||
    segment === '.' ||
    segment === '..' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment))) {
    fail(`unsafe bundle path: ${file}`);
  }
}

function discoverBundle(directory: string) {
  const rootEntries = readdirSync(directory).sort();
  const primaryCandidates = rootEntries.filter(name => {
    const entry = lstatSync(join(directory, name));
    return entry.isFile() && PRIMARY_EXTENSIONS.has(extname(name).toLowerCase());
  });
  if (primaryCandidates.length !== 1) {
    fail(`bundle directory must contain exactly one root document; candidates: ${primaryCandidates.join(', ') || '(none)'}`);
  }
  const primary = join(directory, primaryCandidates[0]);
  const companions: CompanionFile[] = [];
  const seen = new Set<string>();

  function walk(current: string) {
    for (const name of readdirSync(current).sort()) {
      const absolutePath = join(current, name);
      if (absolutePath === primary) continue;
      const stat = lstatSync(absolutePath);
      const relativePath = relative(directory, absolutePath).split(sep).join('/');
      validateBundlePath(relativePath);
      if (stat.isSymbolicLink()) fail(`bundle cannot contain symlinks: ${relativePath}`);
      if (stat.isDirectory()) {
        walk(absolutePath);
        continue;
      }
      if (!stat.isFile()) fail(`bundle contains unsupported filesystem entry: ${relativePath}`);
      const type = COMPANION_TYPES[extname(relativePath).toLowerCase()];
      if (!type) fail(`unsupported bundle file: ${relativePath}`);
      const folded = relativePath.toLowerCase();
      if (seen.has(folded)) fail(`duplicate bundle path: ${relativePath}`);
      seen.add(folded);
      if (stat.size > MAX_BUNDLE_FILE_BYTES) fail(`bundle file exceeds ${MAX_BUNDLE_FILE_BYTES} bytes: ${relativePath}`);
      companions.push({ absolutePath, path: relativePath, size: stat.size });
      if (companions.length > MAX_BUNDLE_FILES) fail(`bundle exceeds ${MAX_BUNDLE_FILES} companion files`);
    }
  }
  walk(directory);
  companions.sort((a, b) => a.path.localeCompare(b.path));
  return { primary, companions };
}

async function api(path: string, init?: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(BASE + path, init);
  } catch {
    console.error(`Error: cannot reach vault server at ${BASE}`);
    console.error('Start it with `npm run dev` / `docker compose up`, or set VAULT_URL.');
    process.exit(1);
  }
  if (!res.ok) {
    console.error(`Error ${res.status}: ${await res.text()}`);
    process.exit(1);
  }
  return res;
}

function openBrowser(url: string) {
  if (process.env.VAULT_NO_BROWSER) return;
  const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '""', url] : [url];
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
}

const program = new Command();
program.name('vault').description('AI document vault CLI');

program
  .command('add <file>')
  .option('--project <name>', 'project folder', 'misc')
  .option('--title <title>', 'HTML/Markdown title (default: file name; AgentDoc title comes from source)')
  .option('--source-repo <path>', 'code repo the doc was generated from')
  .option('--model <name>', 'model that generated the doc')
  .option('--transcript <ref>', 'transcript reference')
  .action(async (file: string, opts) => {
    let stat;
    try {
      stat = lstatSync(file);
    } catch {
      console.error(`Error: cannot read file: ${file}`);
      process.exit(1);
    }
    if (stat.isSymbolicLink()) fail(`cannot upload symlink: ${file}`);
    const bundle = stat.isDirectory() ? discoverBundle(file) : null;
    if (!bundle && !stat.isFile()) fail(`cannot read file: ${file}`);
    const primary = bundle?.primary ?? file;
    let content: Buffer;
    try {
      content = readFileSync(primary);
    } catch {
      fail(`cannot read file: ${primary}`);
    }
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(content)], { type: mediaType(primary) }), basename(primary));
    if (bundle) {
      const files = bundle.companions.map((companion, index) => ({
        field: `asset_${index}`,
        path: companion.path,
        size: companion.size,
      }));
      form.append('bundle_manifest', JSON.stringify({ version: 1, files }));
      bundle.companions.forEach((companion, index) => {
        const bytes = readFileSync(companion.absolutePath);
        form.append(`asset_${index}`, new Blob([new Uint8Array(bytes)], {
          type: COMPANION_TYPES[extname(companion.path).toLowerCase()],
        }), basename(companion.path));
      });
    }
    form.append('project', opts.project);
    if (opts.title) form.append('title', opts.title);
    if (opts.sourceRepo) form.append('source_repo', opts.sourceRepo);
    if (opts.model) form.append('model', opts.model);
    if (opts.transcript) form.append('transcript', opts.transcript);
    const doc = await (await api('/api/docs', { method: 'POST', body: form })).json();
    console.log(`${doc.update ? 'Updated' : 'Added'} ${doc.project}/${doc.slug}`);
    for (const warning of doc.warnings ?? []) console.warn(`Warning: ${warning}`);
  });

program
  .command('list')
  .action(async () => {
    const docs: any[] = await (await api('/api/docs')).json();
    const groups = new Map<string, any[]>();
    for (const d of docs) groups.set(d.project, [...(groups.get(d.project) ?? []), d]);
    for (const [project, list] of [...groups].sort()) {
      console.log(`${project}/`);
      for (const d of list.sort((a, b) => b.created.localeCompare(a.created))) {
        console.log(`  ${d.slug}  ${d.title}`);
      }
    }
  });

program
  .command('open <slug>')
  .action(async (slug: string) => {
    const doc = await (await api(`/api/docs/${slug}`)).json();
    const cfg = await (await api('/api/config')).json();
    const url = new URL(BASE);
    url.port = String(cfg.docsPort);
    url.pathname = `/${doc.project}/${doc.slug}/`;
    console.log(url.toString());
    openBrowser(url.toString());
  });

program
  .command('reindex')
  .action(async () => {
    const r = await (await api('/api/reindex', { method: 'POST' })).json();
    console.log(`Indexed ${r.indexed} documents`);
  });

program.parse();
