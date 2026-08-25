import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApps, type Apps } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { loadAppConfig } from '../src/settings.js';

let dir: string;
let appConfig: string;
let apps: Apps;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'settings-test-'));
  appConfig = path.join(await mkdtemp(path.join(tmpdir(), 'app-config-')), 'agentdocs.toml');
  process.env.APP_CONFIG = appConfig;
  apps = await createApps(dir);
});

afterEach(async () => {
  apps.db.close();
  delete process.env.APP_CONFIG;
  await rm(dir, { recursive: true, force: true });
  await rm(path.dirname(appConfig), { recursive: true, force: true });
});

function postSettings(body: Record<string, unknown>) {
  return apps.api.request('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('GET /api/settings', () => {
  it('returns current vault settings', async () => {
    const res = await apps.api.request('/api/settings');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.vaultDir).toBe(dir);
    expect(body.defaultProject).toBe('misc');
    expect(body.gitUserName).toBeTruthy();
    expect(body.gitUserEmail).toBeTruthy();
  });
});

describe('POST /api/settings', () => {
  it('persists defaultProject to vault.toml', async () => {
    const res = await postSettings({ defaultProject: 'Demo Project' });
    expect(res.status).toBe(200);
    expect(loadConfig(dir).defaultProject).toBe('demo-project');
  });

  it('round-trips collapseAfter through vault.toml', async () => {
    const res = await postSettings({ collapseAfter: 5 });
    expect(res.status).toBe(200);
    expect(loadConfig(dir).collapseAfter).toBe(5);
    const get = await apps.api.request('/api/settings');
    expect((await get.json()).collapseAfter).toBe(5);
  });

  it('rejects invalid collapseAfter', async () => {
    const res = await postSettings({ collapseAfter: 0 });
    expect(res.status).toBe(400);
  });

  it('sets git identity in the vault repo', async () => {
    await postSettings({ gitUserName: 'Ada', gitUserEmail: 'ada@example.com' });
    const { stdout: name } = await execa('git', ['-C', dir, 'config', 'user.name']);
    const { stdout: email } = await execa('git', ['-C', dir, 'config', 'user.email']);
    expect(name).toBe('Ada');
    expect(email).toBe('ada@example.com');
  });

  it('writes vaultDir to app config and invokes hook', async () => {
    const newDir = path.join(dir, '..', 'settings-test-new-vault');
    let hooked: string | undefined;
    apps.db.close();
    apps = await createApps(dir, { onVaultDirChanged: async d => { hooked = d; } });
    const res = await postSettings({ vaultDir: newDir });
    expect(res.status).toBe(200);
    expect((await res.json()).swapped).toBe(true);
    expect(hooked).toBe(path.resolve(newDir));
    expect(loadAppConfig().vaultDir).toBe(path.resolve(newDir));
    expect(existsSync(appConfig)).toBe(true);
    await rm(newDir, { recursive: true, force: true });
  });

  it('reports swapped=false without hook', async () => {
    const res = await postSettings({ vaultDir: path.join(dir, '..', 'settings-test-new-vault') });
    expect((await res.json()).swapped).toBe(false);
    await rm(path.join(dir, '..', 'settings-test-new-vault'), { recursive: true, force: true });
  });

  it('rejects vaultDir that is an existing file', async () => {
    const file = path.join(dir, 'a-file');
    await writeFile(file, 'x');
    const res = await postSettings({ vaultDir: file });
    expect(res.status).toBe(400);
  });
});
