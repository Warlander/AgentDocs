import { describe, expect, it } from 'vitest';
import { parseDocumentScroll } from '../src/document-scroll.js';

describe('parseDocumentScroll', () => {
  it('accepts normalized document scroll messages', () => {
    expect(parseDocumentScroll({ type: 'agentdocs:scroll', ratio: 0.42 })).toBe(0.42);
  });

  it.each([
    null,
    { type: 'other', ratio: 0.5 },
    { type: 'agentdocs:scroll', ratio: -0.1 },
    { type: 'agentdocs:scroll', ratio: 1.1 },
    { type: 'agentdocs:scroll', ratio: '0.5' },
  ])('rejects invalid messages: %j', value => {
    expect(parseDocumentScroll(value)).toBeNull();
  });
});
