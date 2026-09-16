export interface OrderableDocument {
  slug: string;
  title: string;
  created: string;
  updated?: string;
  favorite: boolean;
}

export function sortProjectDocuments<T extends OrderableDocument>(documents: readonly T[]): T[] {
  return [...documents].sort((a, b) =>
    Number(b.favorite) - Number(a.favorite) ||
    (b.updated || b.created).localeCompare(a.updated || a.created) ||
    b.created.localeCompare(a.created) ||
    a.title.localeCompare(b.title) ||
    a.slug.localeCompare(b.slug));
}

export function latestProjectUpdate(documents: readonly OrderableDocument[]): string {
  return documents.reduce((latest, document) => {
    const updated = document.updated || document.created;
    return updated > latest ? updated : latest;
  }, '');
}
