import { describe, expect, it } from 'vitest';
import { initialDiffRange } from '../src/diff-range.js';

const versions = [
  { sha: 'newest' },
  { sha: 'middle' },
  { sha: 'oldest' },
];

describe('initialDiffRange', () => {
  it('compares latest with the immediately older revision', () => {
    expect(initialDiffRange(versions, '')).toEqual({ from: 'middle', to: 'newest' });
  });

  it('compares a viewed historical revision with its immediately older revision', () => {
    expect(initialDiffRange(versions, 'middle')).toEqual({ from: 'oldest', to: 'middle' });
  });

  it('leaves from empty when the viewed revision has no predecessor', () => {
    expect(initialDiffRange(versions, 'oldest')).toEqual({ from: '', to: 'oldest' });
  });
});
