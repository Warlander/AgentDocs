import path from 'node:path';
import { serve } from '@hono/node-server';
import { createApps } from './app.js';

const vaultDir = path.resolve(
  process.env.VAULT_DIR ?? path.join(import.meta.dirname, '..', '..', '..', 'vault'),
);
const { api, docsApp, config } = await createApps(vaultDir);

const host = process.env.HOST ?? '127.0.0.1';
serve({ fetch: api.fetch, port: config.apiPort, hostname: host });
serve({ fetch: docsApp.fetch, port: config.docsPort, hostname: host });
const displayHost = host === '0.0.0.0' ? 'localhost' : host;
console.log(`API + UI  http://${displayHost}:${config.apiPort}`);
console.log(`Docs      http://${displayHost}:${config.docsPort}  (vault: ${vaultDir})`);
