import Database from 'better-sqlite3';

export interface DocRow {
  slug: string;
  project: string;
  title: string;
  created: string;
  latestSha: string | null;
}

export type Db = Database.Database;

export function openDb(file: string): Db {
  const db = new Database(file);
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(
    slug UNINDEXED, project, title, body, created UNINDEXED)`);
  db.exec(`CREATE TABLE IF NOT EXISTS doc_state(
    slug TEXT PRIMARY KEY, latest_sha TEXT)`);
  return db;
}

export function upsertDoc(db: Db, d: DocRow & { body: string }) {
  db.prepare('DELETE FROM docs WHERE slug = ?').run(d.slug);
  db.prepare('INSERT INTO docs (slug, project, title, body, created) VALUES (?, ?, ?, ?, ?)')
    .run(d.slug, d.project, d.title, d.body, d.created);
  db.prepare(`INSERT INTO doc_state (slug, latest_sha) VALUES (?, ?)
    ON CONFLICT(slug) DO UPDATE SET latest_sha = excluded.latest_sha`)
    .run(d.slug, d.latestSha);
}

const LIST_SQL = `SELECT docs.slug, docs.project, docs.title, docs.created, doc_state.latest_sha AS latestSha
  FROM docs LEFT JOIN doc_state ON doc_state.slug = docs.slug`;

export function listDocs(db: Db, q?: string, project?: string): DocRow[] {
  if (q) {
    const match = q.split(/\s+/)
      .map(t => t.replace(/[^\p{L}\p{N}_]/gu, '').toLowerCase())
      .filter(Boolean)
      .map(t => `${t}*`)
      .join(' ');
    if (match) {
      const sql = LIST_SQL + ' WHERE docs MATCH ?' + (project ? ' AND project = ?' : '');
      return db.prepare(sql).all(...(project ? [match, project] : [match])) as DocRow[];
    }
  }
  const sql = LIST_SQL + (project ? ' WHERE project = ?' : '');
  return db.prepare(sql).all(...(project ? [project] : [])) as DocRow[];
}

export function getDoc(db: Db, slug: string): DocRow | undefined {
  return db.prepare(LIST_SQL + ' WHERE docs.slug = ?').get(slug) as DocRow | undefined;
}

export function clearDocs(db: Db) {
  db.exec('DELETE FROM docs');
  db.exec('DELETE FROM doc_state');
}
