import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'smol-toml';

export interface VaultConfig {
  apiPort: number;
  docsPort: number;
  defaultProject: string;
  collapseAfter: number;
}

export function loadConfig(vaultDir: string): VaultConfig {
  const file = path.join(vaultDir, 'vault.toml');
  const cfg: any = existsSync(file) ? parse(readFileSync(file, 'utf8')) : {};
  const collapseAfter = Number(cfg.ui?.collapse_after);
  return {
    apiPort: Number(process.env.PORT ?? cfg.server?.api_port ?? 3000),
    docsPort: Number(process.env.DOCS_PORT ?? cfg.server?.docs_port ?? 3001),
    defaultProject: cfg.defaults?.project ?? 'misc',
    collapseAfter: Number.isInteger(collapseAfter) && collapseAfter >= 1 ? collapseAfter : 8,
  };
}
