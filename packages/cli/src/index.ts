#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { Command } from 'commander';

const BASE = (process.env.VAULT_URL ?? 'http://localhost:3000').replace(/\/+$/, '');

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
program.name('vault').description('AI HTML document vault CLI');

program
  .command('add <file>')
  .option('--project <name>', 'project folder', 'misc')
  .option('--title <title>', 'document title (default: file name)')
  .option('--source-repo <path>', 'code repo the doc was generated from')
  .option('--model <name>', 'model that generated the doc')
  .option('--transcript <ref>', 'transcript reference')
  .action(async (file: string, opts) => {
    let content: Buffer;
    try {
      content = readFileSync(file);
    } catch {
      console.error(`Error: cannot read file: ${file}`);
      process.exit(1);
    }
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(content)], { type: 'text/html' }), basename(file));
    form.append('project', opts.project);
    if (opts.title) form.append('title', opts.title);
    if (opts.sourceRepo) form.append('source_repo', opts.sourceRepo);
    if (opts.model) form.append('model', opts.model);
    if (opts.transcript) form.append('transcript', opts.transcript);
    const doc = await (await api('/api/docs', { method: 'POST', body: form })).json();
    console.log(`${doc.update ? 'Updated' : 'Added'} ${doc.project}/${doc.slug}`);
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
    url.pathname = `/${doc.project}/${doc.slug}`;
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
