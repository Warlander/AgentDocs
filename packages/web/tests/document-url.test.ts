import { describe, expect, it } from 'vitest';
import { documentUrl } from '../src/document-url.js';

describe('documentUrl', () => {
  const document = { project: 'demo', slug: 'report' };

  it('builds the canonical latest URL', () => {
    expect(documentUrl('http://localhost:3001', document)).toBe('http://localhost:3001/demo/report/');
  });

  it('builds the canonical historical URL', () => {
    expect(documentUrl('http://localhost:3001/', document, 'abc1234')).toBe(
      'http://localhost:3001/demo/report/_history/abc1234/');
  });
});
