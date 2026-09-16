export function documentUrl(origin: string, document: { project: string; slug: string }, sha = '', viewer = false) {
  const base = `${origin.replace(/\/+$/, '')}/${document.project}/${document.slug}/`;
  const url = sha ? `${base}_history/${sha}/` : base;
  return viewer ? `${url}?viewer=1` : url;
}
