import { describe, expect, it } from 'vitest';
import { parseVaultNavigation } from '../src/vault-navigation.js';

describe('parseVaultNavigation', () => {
  it('accepts a valid vault navigation message', () => {
    expect(parseVaultNavigation({
      type: 'agentdocs:navigate',
      project: 'agent-docs',
      slug: 'dsl-specification',
    })).toEqual({ project: 'agent-docs', slug: 'dsl-specification' });
  });

  it.each([
    null,
    { type: 'other', project: 'demo', slug: 'doc' },
    { type: 'agentdocs:navigate', project: '../demo', slug: 'doc' },
    { type: 'agentdocs:navigate', project: 'demo', slug: 'Doc' },
  ])('rejects unrelated or unsafe messages', message => {
    expect(parseVaultNavigation(message)).toBeNull();
  });
});
