import { spawn } from 'node:child_process';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

const CLI = path.join(import.meta.dirname, '..', 'src', 'index.ts');
const CWD = path.join(import.meta.dirname, '..');

interface Captured { method: string; url: string; body: string }

function runCli(args: string[], env: Record<string, string> = {}) {
  return new Promise<{ code: number; stdout: string; stderr: string }>(resolve => {
    const proc = spawn(process.execPath, ['--import', 'tsx', CLI, ...args], {
      cwd: CWD,
      env: { ...process.env, VAULT_NO_BROWSER: '1', ...env },
    });
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => (stdout += d));
    proc.stderr.on('data', d => (stderr += d));
    proc.on('close', code => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

function startStub(handler: (req: Captured, res: http.ServerResponse) => void) {
  const requests: Captured[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      const captured = { method: req.method!, url: req.url!, body };
      requests.push(captured);
      handler(captured, res);
    });
  });
  return new Promise<{ url: string; requests: Captured[]; close: () => void }>(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}`, requests, close: () => server.close() });
    });
  });
}

let dir: string;
let file: string;

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function makeFile(content = '<p>cli test</p>', name = 'f.html') {
  dir = await mkdtemp(path.join(tmpdir(), 'cli-test-'));
  file = path.join(dir, name);
  writeFileSync(file, content);
  return file;
}

async function makeBundle(primary = 'report.html') {
  dir = await mkdtemp(path.join(tmpdir(), 'cli-test-'));
  writeFileSync(path.join(dir, primary), '<link rel="stylesheet" href="styles.css"><img src="assets/panel.png">');
  mkdirSync(path.join(dir, 'assets'));
  writeFileSync(path.join(dir, 'assets', 'panel.png'), new Uint8Array([1, 2, 3]));
  writeFileSync(path.join(dir, 'styles.css'), 'body{}');
  return dir;
}

describe('vault CLI', () => {
  it('fails on unreadable file', async () => {
    const r = await runCli(['add', 'nope.html']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('cannot read file');
  });

  it('fails when server unreachable', async () => {
    const r = await runCli(['list'], { VAULT_URL: 'http://127.0.0.1:1' });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('cannot reach vault server');
  });

  it('adds a doc and prints Added', async () => {
    const stub = await startStub((req, res) => {
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ project: 'demo', slug: 'f', update: false }));
    });
    const f = await makeFile();
    const r = await runCli(['add', f, '--project', 'demo'], { VAULT_URL: stub.url });
    stub.close();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Added demo/f');
    const post = stub.requests.find(q => q.method === 'POST' && q.url === '/api/docs')!;
    expect(post.body).toContain('name="project"');
    expect(post.body).toContain('demo');
    expect(post.body).toContain('<p>cli test</p>');
  });

  it('uploads Markdown with its media type', async () => {
    const stub = await startStub((req, res) => {
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ project: 'demo', slug: 'f', update: false }));
    });
    const f = await makeFile('# Markdown', 'f.md');
    const r = await runCli(['add', f, '--project', 'demo'], { VAULT_URL: stub.url });
    stub.close();
    expect(r.code).toBe(0);
    const post = stub.requests.find(q => q.method === 'POST' && q.url === '/api/docs')!;
    expect(post.body).toContain('filename="f.md"');
    expect(post.body).toContain('Content-Type: text/markdown');
  });

  it('uploads AgentDoc with its media type', async () => {
    const stub = await startStub((req, res) => {
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ project: 'demo', slug: 'source-id', update: false }));
    });
    const f = await makeFile('@schema agentdocs/v1', 'source.agentdoc');
    const r = await runCli(['add', f, '--project', 'demo'], { VAULT_URL: stub.url });
    stub.close();
    expect(r.code).toBe(0);
    const post = stub.requests.find(q => q.method === 'POST' && q.url === '/api/docs')!;
    expect(post.body).toContain('filename="source.agentdoc"');
    expect(post.body).toContain('Content-Type: application/vnd.agentdocs+text');
    expect(post.body).not.toContain('name="title"');
  });

  it('prints Updated on re-upload', async () => {
    const stub = await startStub((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ project: 'demo', slug: 'f', update: true }));
    });
    const f = await makeFile();
    const r = await runCli(['add', f, '--project', 'demo'], { VAULT_URL: stub.url });
    stub.close();
    expect(r.stdout).toContain('Updated demo/f');
  });

  it.each(['report.html', 'report.md', 'report.agentdoc'])('uploads a directory bundle with one root %s', async primary => {
    const stub = await startStub((_req, res) => {
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ project: 'demo', slug: 'report', update: false }));
    });
    const bundle = await makeBundle(primary);
    const r = await runCli(['add', bundle, '--project', 'demo'], { VAULT_URL: stub.url });
    stub.close();
    expect(r.code).toBe(0);
    const post = stub.requests.find(q => q.method === 'POST')!;
    expect(post.body).toContain(`filename="${primary}"`);
    expect(post.body).toContain('name="bundle_manifest"');
    expect(post.body).toContain('assets/panel.png');
    expect(post.body).toContain('styles.css');
    expect(post.body).toContain('name="asset_0"');
    expect(post.body).toContain('name="asset_1"');
    expect(post.body.indexOf('"path":"assets/panel.png"')).toBeLessThan(post.body.indexOf('"path":"styles.css"'));
  });

  it('rejects zero and multiple root documents before upload', async () => {
    const stub = await startStub((_req, res) => res.end('{}'));
    dir = await mkdtemp(path.join(tmpdir(), 'cli-test-'));
    writeFileSync(path.join(dir, 'styles.css'), 'body{}');
    const zero = await runCli(['add', dir], { VAULT_URL: stub.url });
    writeFileSync(path.join(dir, 'one.md'), '# One');
    writeFileSync(path.join(dir, 'two.html'), '<p>Two</p>');
    const multiple = await runCli(['add', dir], { VAULT_URL: stub.url });
    stub.close();
    expect(zero.code).toBe(1);
    expect(zero.stderr).toContain('candidates: (none)');
    expect(multiple.code).toBe(1);
    expect(multiple.stderr).toContain('one.md, two.html');
    expect(stub.requests).toHaveLength(0);
  });

  it('rejects unsupported companions and symlinks before upload', async () => {
    const stub = await startStub((_req, res) => res.end('{}'));
    const bundle = await makeBundle();
    writeFileSync(path.join(bundle, 'script.js'), 'alert(1)');
    const unsupported = await runCli(['add', bundle], { VAULT_URL: stub.url });
    expect(unsupported.code).toBe(1);
    expect(unsupported.stderr).toContain('unsupported bundle file');
    await rm(path.join(bundle, 'script.js'));
    symlinkSync(path.join(bundle, 'styles.css'), path.join(bundle, 'linked.css'));
    const symlink = await runCli(['add', bundle], { VAULT_URL: stub.url });
    stub.close();
    expect(symlink.code).toBe(1);
    expect(symlink.stderr).toContain('symlinks');
    expect(stub.requests).toHaveLength(0);
  });

  it('passes title/model/transcript metadata', async () => {
    const stub = await startStub((req, res) => {
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ project: 'demo', slug: 'f', update: false }));
    });
    const f = await makeFile();
    await runCli(['add', f, '--project', 'demo', '--title', 'MyTitle', '--model', 'claude', '--transcript', 'abc123'], { VAULT_URL: stub.url });
    stub.close();
    const post = stub.requests.find(q => q.method === 'POST')!;
    for (const [field, value] of [['title', 'MyTitle'], ['model', 'claude'], ['transcript', 'abc123']]) {
      expect(post.body).toContain(`name="${field}"`);
      expect(post.body).toContain(value);
    }
  });

  it('prints docs-origin URL on open', async () => {
    const stub = await startStub((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url === '/api/docs/report') res.end(JSON.stringify({ project: 'demo', slug: 'report' }));
      else if (req.url === '/api/config') res.end(JSON.stringify({ docsPort: 3001 }));
      else res.end('{}');
    });
    const r = await runCli(['open', 'report'], { VAULT_URL: stub.url });
    stub.close();
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toMatch(/http:\/\/127\.0\.0\.1:3001\/demo\/report\/$/);
  });
});
