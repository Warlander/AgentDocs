import Database from 'better-sqlite3';

export interface DocRow {
  slug: string;
  project: string;
  title: string;
  created: string;
  latestSha: string | null;
  favorite: boolean;
}

export type Db = Database.Database;

export function openDb(file: string): Db {
  const db = new Database(file);
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(
    slug UNINDEXED, project, title, body, created UNINDEXED)`);
  db.exec(`CREATE TABLE IF NOT EXISTS doc_state(
    slug TEXT PRIMARY KEY, latest_sha TEXT)`);
  // Favorites live outside the search index: clearDocs must never wipe them
  db.exec(`CREATE TABLE IF NOT EXISTS favorites(
    slug TEXT PRIMARY KEY)`);
  return db;
}

export function upsertDoc(db: Db, d: Omit<DocRow, 'favorite'> & { body: string }) {
  db.prepare('DELETE FROM docs WHERE slug = ?').run(d.slug);
  db.prepare('INSERT INTO docs (slug, project, title, body, created) VALUES (?, ?, ?, ?, ?)')
    .run(d.slug, d.project, d.title, d.body, d.created);
  db.prepare(`INSERT INTO doc_state (slug, latest_sha) VALUES (?, ?)
    ON CONFLICT(slug) DO UPDATE SET latest_sha = excluded.latest_sha`)
    .run(d.slug, d.latestSha);
}

const LIST_SQL = `SELECT docs.slug, docs.project, docs.title, docs.created, doc_state.latest_sha AS latestSha,
    (favorites.slug IS NOT NULL) AS favorite
  FROM docs
  LEFT JOIN doc_state ON doc_state.slug = docs.slug
  LEFT JOIN favorites ON favorites.slug = docs.slug`;

export function setFavorite(db: Db, slug: string, favorite: boolean) {
  if (favorite) db.prepare('INSERT OR IGNORE INTO favorites (slug) VALUES (?)').run(slug);
  else db.prepare('DELETE FROM favorites WHERE slug = ?').run(slug);
}

// better-sqlite3 returns the IS NOT NULL expression as 0/1 — normalize to boolean
const toBool = (rows: DocRow[]) => rows.map(d => ({ ...d, favorite: !!d.favorite }));

export function listDocs(db: Db, q?: string, project?: string): DocRow[] {
  if (q) {
    const match = q.split(/\s+/)
      .map(t => t.replace(/[^\p{L}\p{N}_]/gu, '').toLowerCase())
      .filter(Boolean)
      .map(t => `${t}*`)
      .join(' ');
    if (match) {
      const sql = LIST_SQL + ' WHERE docs MATCH ?' + (project ? ' AND project = ?' : '');
      return toBool(db.prepare(sql).all(...(project ? [match, project] : [match])) as DocRow[]);
    }
  }
  const sql = LIST_SQL + (project ? ' WHERE project = ?' : '');
  return toBool(db.prepare(sql).all(...(project ? [project] : [])) as DocRow[]);
}

export function getDoc(db: Db, slug: string): DocRow | undefined {
  const row = db.prepare(LIST_SQL + ' WHERE docs.slug = ?').get(slug) as DocRow | undefined;
  return row && toBool([row])[0];
}

export function clearDocs(db: Db) {
  db.exec('DELETE FROM docs');
  db.exec('DELETE FROM doc_state');
}
