import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parse, stringify } from 'smol-toml';

export interface AppConfig {
  vaultDir?: string;
}

export function appConfigPath(): string {
  return process.env.APP_CONFIG
    ?? path.join(import.meta.dirname, '..', '..', '..', 'agentdocs.toml');
}

export function loadAppConfig(): AppConfig {
  const file = appConfigPath();
  if (!existsSync(file)) return {};
  const cfg: any = parse(readFileSync(file, 'utf8'));
  return { vaultDir: cfg.vault?.dir ? String(cfg.vault.dir) : undefined };
}

export function saveVaultDir(dir: string) {
  writeFileSync(appConfigPath(), stringify({ vault: { dir } }));
}

export function defaultVaultDir(): string {
  return path.join(import.meta.dirname, '..', '..', '..', 'vault');
}

export function resolveVaultDir(): string {
  return path.resolve(process.env.VAULT_DIR ?? loadAppConfig().vaultDir ?? defaultVaultDir());
}
