import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { git } from './git.js';

const DEFAULT_TOML = `[server]
api_port = 3000
docs_port = 3001

[defaults]
project = "misc"
`;

export async function ensureVault(vaultDir: string) {
  mkdirSync(path.join(vaultDir, 'docs'), { recursive: true });
  if (!existsSync(path.join(vaultDir, '.git'))) {
    await git(vaultDir, ['init']);
  }
  const hasConfig = async (key: string) =>
    git(vaultDir, ['config', key]).then(() => true, () => false);
  if (!(await hasConfig('user.name'))) {
    await git(vaultDir, ['config', 'user.name', 'Vault']);
  }
  if (!(await hasConfig('user.email'))) {
    await git(vaultDir, ['config', 'user.email', 'vault@localhost']);
  }
  if (!existsSync(path.join(vaultDir, 'vault.toml'))) {
    writeFileSync(path.join(vaultDir, 'vault.toml'), DEFAULT_TOML);
  }
  if (!existsSync(path.join(vaultDir, '.gitignore'))) {
    writeFileSync(path.join(vaultDir, '.gitignore'), 'index.db\n');
  }
  const hasCommits = await git(vaultDir, ['log', '-1']).then(() => true, () => false);
  if (!hasCommits) {
    await git(vaultDir, ['add', 'vault.toml', '.gitignore']);
    await git(vaultDir, ['commit', '-m', 'Initialize vault']);
  }
}
