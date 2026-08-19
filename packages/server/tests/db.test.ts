import { beforeEach, describe, expect, it } from 'vitest';
import { clearDocs, getDoc, listDocs, openDb, setFavorite, upsertDoc, type Db } from '../src/db.js';

let db: Db;

beforeEach(() => {
  db = openDb(':memory:');
  upsertDoc(db, { slug: 'report', project: 'demo', title: 'Quarterly Report', created: '2026-01-01', body: 'revenue grew', latestSha: 'aaa' });
  upsertDoc(db, { slug: 'notes', project: 'misc', title: 'Meeting Notes', created: '2026-01-02', body: 'budget cuts', latestSha: 'bbb' });
});

describe('listDocs FTS query escaping', () => {
  it('matches plain term', () => {
    expect(listDocs(db, 'revenue').map(d => d.slug)).toEqual(['report']);
  });

  it('prefix-matches partial term', () => {
    expect(listDocs(db, 'rev').map(d => d.slug)).toEqual(['report']);
  });

  it('strips FTS syntax chars without throwing', () => {
    expect(() => listDocs(db, '"revenue" OR (budget)')).not.toThrow();
  });

  it('treats FTS operators as literal text', () => {
    // 'NEAR/3' lowercases to plain term 'near3', which no body contains
    expect(() => listDocs(db, 'NEAR/3 revenue')).not.toThrow();
    expect(listDocs(db, 'NEAR/3 revenue')).toEqual([]);
  });

  it('falls through to unfiltered list on only-symbols query', () => {
    expect(listDocs(db, '!!!')).toHaveLength(2);
  });

  it('filters by project', () => {
    expect(listDocs(db, undefined, 'misc').map(d => d.slug)).toEqual(['notes']);
  });

  it('combines query and project filter', () => {
    expect(listDocs(db, 'revenue', 'misc')).toHaveLength(0);
  });
});

describe('upsertDoc / getDoc', () => {
  it('inserts and reads back', () => {
    const doc = getDoc(db, 'report');
    expect(doc?.title).toBe('Quarterly Report');
    expect(doc?.latestSha).toBe('aaa');
  });

  it('re-upsert same slug keeps single row and updates state', () => {
    upsertDoc(db, { slug: 'report', project: 'demo', title: 'New Title', created: '2026-01-01', body: 'x', latestSha: 'ccc' });
    expect(listDocs(db).filter(d => d.slug === 'report')).toHaveLength(1);
    expect(getDoc(db, 'report')?.latestSha).toBe('ccc');
  });

  it('returns undefined for unknown slug', () => {
    expect(getDoc(db, 'nope')).toBeUndefined();
  });
});

describe('favorites', () => {
  it('docs are not favorited by default', () => {
    expect(listDocs(db).map(d => d.favorite)).toEqual([false, false]);
  });

  it('setFavorite toggles the flag in list and get', () => {
    setFavorite(db, 'report', true);
    expect(getDoc(db, 'report')?.favorite).toBe(true);
    expect(listDocs(db).find(d => d.slug === 'notes')?.favorite).toBe(false);
    setFavorite(db, 'report', false);
    expect(getDoc(db, 'report')?.favorite).toBe(false);
  });

  it('favoriting an unknown slug is a harmless no-op', () => {
    setFavorite(db, 'ghost', true);
    expect(listDocs(db).every(d => !d.favorite)).toBe(true);
  });

  it('favorites survive clearDocs (reindex)', () => {
    setFavorite(db, 'report', true);
    clearDocs(db);
    upsertDoc(db, { slug: 'report', project: 'demo', title: 'Quarterly Report', created: '2026-01-01', body: 'revenue grew', latestSha: 'aaa' });
    expect(getDoc(db, 'report')?.favorite).toBe(true);
  });
});
