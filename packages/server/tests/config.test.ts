import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'cfg-test-'));
});

afterEach(async () => {
  delete process.env.PORT;
  delete process.env.DOCS_PORT;
  await rm(dir, { recursive: true, force: true });
});

describe('loadConfig', () => {
  it('returns defaults without toml', () => {
    expect(loadConfig(dir)).toEqual({ apiPort: 3000, docsPort: 3001, defaultProject: 'misc', collapseAfter: 8 });
  });

  it('toml overrides defaults', async () => {
    await writeFile(path.join(dir, 'vault.toml'), '[server]\napi_port = 4000\n[defaults]\nproject = "x"\n[ui]\ncollapse_after = 5\n');
    expect(loadConfig(dir)).toEqual({ apiPort: 4000, docsPort: 3001, defaultProject: 'x', collapseAfter: 5 });
  });

  it('invalid collapse_after falls back to 8', async () => {
    await writeFile(path.join(dir, 'vault.toml'), '[ui]\ncollapse_after = 0\n');
    expect(loadConfig(dir).collapseAfter).toBe(8);
  });

  it('env beats toml', async () => {
    await writeFile(path.join(dir, 'vault.toml'), '[server]\napi_port = 4000\n');
    process.env.PORT = '5000';
    expect(loadConfig(dir).apiPort).toBe(5000);
  });
});
