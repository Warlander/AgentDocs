import { describe, expect, it } from 'vitest';
import { slugify, stripHtml } from '../src/util.js';

describe('slugify', () => {
  it('lowercases and dashes spaces', () => {
    expect(slugify('My Report')).toBe('my-report');
  });

  it.each(['notes.html', 'notes.HTML', 'notes.htm'])('strips extension: %s', s => {
    expect(slugify(s)).toBe('notes');
  });

  it('replaces special chars', () => {
    expect(slugify('Q3: results (final!) v2.0')).toBe('q3-results-final-v2-0');
  });

  it('trims edge dashes', () => {
    expect(slugify('--weird--name--')).toBe('weird-name');
  });

  it.each(['!!!', '', '...'])('falls back to "doc": %s', s => {
    expect(slugify(s)).toBe('doc');
  });

  it('non-ASCII leaves only [a-z0-9-]', () => {
    expect(slugify('zählung — résumé')).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });
});

describe('stripHtml', () => {
  it('removes tags, keeps text', () => {
    expect(stripHtml('<p>Hello <b>world</b></p>')).toBe('Hello world');
  });

  it('guts script content', () => {
    expect(stripHtml('<script>alert("keep none")</script>Visible')).toBe('Visible');
  });

  it('guts style content', () => {
    expect(stripHtml('<style>.x{color:red}</style>Text')).toBe('Text');
  });

  it('collapses whitespace', () => {
    expect(stripHtml('a\n\n  b\t\tc')).toBe('a b c');
  });

  it('is case-insensitive for script/style', () => {
    expect(stripHtml('<SCRIPT>x</SCRIPT>y')).toBe('y');
  });
});
