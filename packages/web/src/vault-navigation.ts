export interface VaultNavigation {
  project: string;
  slug: string;
}

const SAFE_SEGMENT = /^[a-z0-9-]+$/;

export function parseVaultNavigation(data: unknown): VaultNavigation | null {
  if (!data || typeof data !== 'object') return null;
  const message = data as Record<string, unknown>;
  if (message.type !== 'agentdocs:navigate') return null;
  if (typeof message.project !== 'string' || typeof message.slug !== 'string') return null;
  if (!SAFE_SEGMENT.test(message.project) || !SAFE_SEGMENT.test(message.slug)) return null;
  return { project: message.project, slug: message.slug };
}
