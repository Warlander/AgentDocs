export function documentUrl(origin: string, document: { project: string; slug: string }, sha = '') {
  const base = `${origin.replace(/\/+$/, '')}/${document.project}/${document.slug}/`;
  return sha ? `${base}_history/${sha}/` : base;
}
