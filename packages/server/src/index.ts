import { serve } from '@hono/node-server';
import { createApps, type Apps } from './app.js';
import { resolveVaultDir } from './settings.js';

let current: Apps;

async function recreate(vaultDir: string) {
  const next = await createApps(vaultDir, { onVaultDirChanged: recreate });
  await next.reindex();
  current.stop();
  current.db.close();
  current = next;
}

current = await createApps(resolveVaultDir(), { onVaultDirChanged: recreate });

const host = process.env.HOST ?? '127.0.0.1';
const config = current.config;
serve({ fetch: req => current.api.fetch(req), port: config.apiPort, hostname: host });
serve({ fetch: req => current.docsApp.fetch(req), port: config.docsPort, hostname: host });
const displayHost = host === '0.0.0.0' ? 'localhost' : host;
console.log(`API + UI  http://${displayHost}:${config.apiPort}`);
console.log(`Docs      http://${displayHost}:${config.docsPort}  (vault: ${resolveVaultDir()})`);
