import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureVault } from '../src/vault.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'vault-test-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function commitCount() {
  const { stdout } = await execa('git', ['-C', dir, 'rev-list', '--count', 'HEAD']);
  return Number(stdout);
}

describe('ensureVault', () => {
  it('cold start creates structure and initial commit', async () => {
    await ensureVault(dir);
    expect(existsSync(path.join(dir, 'docs'))).toBe(true);
    expect(existsSync(path.join(dir, '.git'))).toBe(true);
    expect(existsSync(path.join(dir, 'vault.toml'))).toBe(true);
    expect(existsSync(path.join(dir, '.gitignore'))).toBe(true);
    expect(await commitCount()).toBe(1);
    const { stdout } = await execa('git', ['-C', dir, 'log', '-1', '--format=%s']);
    expect(stdout).toBe('Initialize vault');
  });

  it('is idempotent', async () => {
    await ensureVault(dir);
    await ensureVault(dir);
    expect(await commitCount()).toBe(1);
  });

  it('keeps pre-configured git identity', async () => {
    await execa('git', ['-C', dir, 'init']);
    await execa('git', ['-C', dir, 'config', 'user.email', 'custom@example.com']);
    await ensureVault(dir);
    const { stdout } = await execa('git', ['-C', dir, 'config', 'user.email']);
    expect(stdout).toBe('custom@example.com');
  });
});
