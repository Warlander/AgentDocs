import { describe, expect, it } from 'vitest';
import { latestProjectUpdate, sortProjectDocuments } from '../src/document-order.js';

describe('sortProjectDocuments', () => {
  it('moves a recently updated older document above a newer upload', () => {
    const documents = [
      { slug: 'new', title: 'New', created: '2026-02-01', updated: '2026-02-01', favorite: false },
      { slug: 'old', title: 'Old', created: '2026-01-01', updated: '2026-03-01', favorite: false },
    ];
    expect(sortProjectDocuments(documents).map(document => document.slug)).toEqual(['old', 'new']);
  });

  it('keeps favorites pinned above recent non-favorites', () => {
    const documents = [
      { slug: 'recent', title: 'Recent', created: '2026-02-01', updated: '2026-03-01', favorite: false },
      { slug: 'favorite', title: 'Favorite', created: '2026-01-01', updated: '2026-01-01', favorite: true },
    ];
    expect(sortProjectDocuments(documents).map(document => document.slug)).toEqual(['favorite', 'recent']);
  });

  it('uses the most recent document update to rank a project', () => {
    const documents = [
      { slug: 'new', title: 'New', created: '2026-02-01', updated: '2026-02-01', favorite: false },
      { slug: 'old', title: 'Old', created: '2026-01-01', updated: '2026-03-01', favorite: true },
    ];
    expect(latestProjectUpdate(documents)).toBe('2026-03-01');
  });
});
